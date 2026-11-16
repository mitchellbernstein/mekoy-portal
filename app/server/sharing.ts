import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ShareLink, SharedVideo } from "../../shared/contracts";
import { accessibleVideo, streamToken } from "./domain";
import { json } from "./http";
import { HttpError, origin, transaction, uuid } from "./runtime";
import type { Runtime, Sql } from "./runtime";
import { encrypt } from "./slack";
import { accountEntitlements } from "./entitlements";
import { chaptersJson } from "./chapters";

type LinkRow={token_ciphertext:string;expires_at:Date;status:ShareLink["status"]};
const tokenHash=(token:string)=>createHash("sha256").update(token).digest("hex");

async function ownedVideo(db:Sql,videoId:string,userId:string) {
  const video=await accessibleVideo(db,videoId,userId,true);
  if(video.owner_id!==userId) throw new HttpError(403,"Only the video owner can manage its viewing link");
  return video;
}

async function linkJson(runtime:Runtime,row:LinkRow):Promise<ShareLink> {
  return {url:`${origin(runtime)}/s/${await encrypt(runtime,row.token_ciphertext,true)}`,expiresAt:new Date(row.expires_at).toISOString(),status:row.status};
}

export async function readShareLink(runtime:Runtime,videoId:string,userId:string):Promise<ShareLink|null> {
  const video=await accessibleVideo(runtime.db,videoId,userId);
  if(video.owner_id!==userId) throw new HttpError(403,"Only the video owner can manage its viewing link");
  const row=(await runtime.db.query("SELECT *,CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS status FROM video_share_links WHERE video_id=$1",[videoId])).rows[0] as LinkRow|undefined;
  return row?linkJson(runtime,row):null;
}

export async function shareLink(runtime:Runtime,videoId:string,userId:string,replace=false):Promise<ShareLink> {
  return transaction(runtime.db,async db=>{
    const video=await ownedVideo(db,videoId,userId);
    let row=(await db.query("SELECT *,CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS status FROM video_share_links WHERE video_id=$1",[videoId])).rows[0] as LinkRow|undefined;
    if(!row||replace) {
      if((await accountEntitlements(db,userId)).plan!=="free"||video.team_id!==null) throw new HttpError(403,"Seven-day viewing links require your own personal free recording. Team videos keep their membership rules");
      if(video.upload_state!=="uploaded") throw new HttpError(409,"Finish uploading before sharing. Keep your original file");
      const token=randomBytes(32).toString("base64url");
      row=(await db.query("INSERT INTO video_share_links(id,video_id,token_hash,token_ciphertext) VALUES($1,$2,$3,$4) ON CONFLICT(video_id) DO UPDATE SET id=excluded.id,token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,created_at=now(),expires_at=now()+interval '168 hours',revoked_at=NULL,stream_token_ciphertext=NULL,stream_token_expires_at=NULL,stream_token_refresh_at=NULL,stream_token_uid=NULL RETURNING *, 'active'::text AS status",[uuid(),videoId,tokenHash(token),await encrypt(runtime,token)])).rows[0] as LinkRow;
    }
    return linkJson(runtime,row);
  });
}

export async function revokeShareLink(runtime:Runtime,videoId:string,userId:string) {
  return transaction(runtime.db,async db=>{
    await ownedVideo(db,videoId,userId);
    await revokeVideoLink(db,videoId);
    return {revoked:true};
  });
}

export async function revokeVideoLink(db:Sql,videoId:string) {
  await db.query("UPDATE video_share_links SET revoked_at=COALESCE(revoked_at,now()),stream_token_ciphertext=NULL,stream_token_expires_at=NULL,stream_token_refresh_at=NULL,stream_token_uid=NULL WHERE video_id=$1",[videoId]);
}

async function sharedPlayback(runtime:Runtime,hash:string,mediaUrl:string) {
  return transaction(runtime.db,async db=>{
    const candidate=(await db.query("SELECT video_id FROM video_share_links WHERE token_hash=$1",[hash])).rows[0];
    if(!candidate) throw new HttpError(404,"Recording link unavailable");
    await db.query("SELECT id FROM videos WHERE id=$1 FOR SHARE",[candidate.video_id]);
    const locked=await db.query("SELECT id FROM video_share_links WHERE token_hash=$1 FOR UPDATE SKIP LOCKED",[hash]);
    const row=(await db.query("SELECT l.*,v.duration_ms,v.stream_uid,v.processing_status,l.stream_token_refresh_at>clock_timestamp() AS refresh_wait,l.stream_token_expires_at>clock_timestamp() AND l.stream_token_expires_at<=l.expires_at AS token_current FROM video_share_links l JOIN videos v ON v.id=l.video_id WHERE l.token_hash=$1 AND l.video_id=$2 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp() AND v.deleted_at IS NULL AND v.team_id IS NULL AND v.upload_state='uploaded'",[hash,candidate.video_id])).rows[0];
    if(!row) throw new HttpError(404,"Recording link unavailable");
    const original={mediaUrl,streamUrl:null};
    if(!locked.rowCount) return original;
    if(row.processing_status!=="stream_ready"||!row.stream_uid||!(row.duration_ms>0)||Math.ceil(row.duration_ms/1000)+900>86_400) return original;
    if(row.refresh_wait&&row.stream_token_uid===row.stream_uid) {
      if(!row.stream_token_ciphertext) return original;
      if(row.token_current) {
        try {return {mediaUrl,streamUrl:`https://iframe.videodelivery.net/${await encrypt(runtime,row.stream_token_ciphertext,true)}`};}
        catch {}
      }
    }
    try {
      const requestedAt=Math.floor(Date.now()/1000);
      const exp=Math.min(requestedAt+Math.ceil(row.duration_ms/1000)+900,Math.floor(new Date(row.expires_at).getTime()/1000));
      const token=await streamToken(runtime,row.stream_uid,exp,5_000);
      z.string().max(16_384).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).parse(token);
      const claims=z.object({sub:z.literal(row.stream_uid),exp:z.union([z.number(),z.string().regex(/^[0-9]+$/)]),downloadable:z.literal(false).optional()}).parse(JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString("utf8")));
      if(Number(claims.exp)!==exp) throw new HttpError(502,"Stream returned an unexpected token expiry");
      const saved=await db.query("UPDATE video_share_links SET stream_token_ciphertext=$2,stream_token_expires_at=to_timestamp($3),stream_token_refresh_at=LEAST(to_timestamp($3),to_timestamp($6)),stream_token_uid=$4 WHERE id=$1 AND token_hash=$5 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND expires_at>=to_timestamp($3) AND to_timestamp($3)>clock_timestamp() RETURNING id",[row.id,await encrypt(runtime,token),exp,row.stream_uid,hash,requestedAt+600]);
      if(!saved.rowCount) throw new HttpError(404,"Recording link unavailable");
      return {mediaUrl,streamUrl:`https://iframe.videodelivery.net/${token}`};
    } catch(error) {
      if(error instanceof HttpError&&error.status===404) throw error;
      const deferred=await db.query("UPDATE video_share_links SET stream_token_ciphertext=NULL,stream_token_expires_at=NULL,stream_token_refresh_at=LEAST(expires_at,clock_timestamp()+interval '1 minute'),stream_token_uid=$2 WHERE id=$1 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING id",[row.id,row.stream_uid,hash]);
      if(!deferred.rowCount) throw new HttpError(404,"Recording link unavailable");
      return original;
    }
  });
}

export async function publicShare(request:Request,runtime:Runtime):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(!path.startsWith("/api/shared/")) return null;
  let response:Response;
  try {
    const match=/^\/api\/shared\/([A-Za-z0-9_-]{43})(?:\/(media|playback))?$/.exec(path);
    if(!match) throw new HttpError(404,"Recording link unavailable");
    if(request.method!=="GET"&&!(request.method==="HEAD"&&match[2]==="media")) throw new HttpError(405,"Method not allowed");
    const mediaUrl=`/api/shared/${match[1]}/media`;
    if(match[2]==="playback") response=json(await sharedPlayback(runtime,tokenHash(match[1]),mediaUrl));
    else {
      const row=(await runtime.db.query("SELECT v.title,v.duration_ms,v.mime_type,v.storage_key,v.chapters,v.transcription_complete,l.expires_at FROM video_share_links l JOIN videos v ON v.id=l.video_id WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND l.expires_at>clock_timestamp() AND v.deleted_at IS NULL AND v.team_id IS NULL AND v.upload_state='uploaded'",[tokenHash(match[1])])).rows[0];
      if(!row) throw new HttpError(404,"Recording link unavailable");
      if(match[2]==="media") {
        response=await runtime.storage.read(row.storage_key,request,row.mime_type);
        response.headers.set("Content-Disposition","inline");
      } else {
        const video:SharedVideo={title:row.title,durationMs:row.duration_ms,mimeType:row.mime_type,expiresAt:new Date(row.expires_at).toISOString(),mediaUrl,playbackUrl:`/api/shared/${match[1]}/playback`,chapters:chaptersJson(row.chapters,row.duration_ms,row.transcription_complete)};
        response=json({video});
      }
    }
  } catch(error) {
    response=json({error:error instanceof HttpError&&[404,405].includes(error.status)?error.message:"This recording cannot play right now. Ask its owner to check the saved recording"},error instanceof HttpError&&[404,405].includes(error.status)?error.status:503);
  }
  response.headers.set("Cache-Control","private, no-store");
  response.headers.set("Referrer-Policy","no-referrer");
  response.headers.set("X-Robots-Tag","noindex, nofollow, noarchive");
  response.headers.set("X-Content-Type-Options","nosniff");
  return response;
}
