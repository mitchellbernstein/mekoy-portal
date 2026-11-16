import type { Activity, Comment, Summary, User, Video } from "../../shared/contracts";
import { enqueue, HttpError, origin, uuid } from "./runtime";
import type { Runtime, Sql } from "./runtime";
import { requireOrganization } from "./entitlements";
import { chaptersJson } from "./chapters";

export const visible = (alias = "v", userParameter = "$1") => `(${alias}.deleted_at IS NULL AND ((${alias}.team_id IS NULL AND ${alias}.owner_id=${userParameter}) OR EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=${alias}.team_id AND m.user_id=${userParameter})))`;
export async function accessibleVideo(db: Sql, id: string, userId: string, lock = false) {
  const result = await db.query(`SELECT v.*,u.name AS owner_name FROM videos v JOIN "user" u ON u.id=v.owner_id WHERE v.id=$2 AND ${visible()}${lock ? " FOR UPDATE OF v" : ""}`, [userId,id]);
  if (!result.rows[0]) throw new HttpError(404,"Video not found");
  return result.rows[0];
}
export async function member(db: Sql, teamId: string, userId: string, ownerOnly = false) {
  const result = await db.query("SELECT role FROM memberships WHERE team_id=$1 AND user_id=$2",[teamId,userId]);
  if (!result.rows[0]) throw new HttpError(404,"Team not found");
  if (ownerOnly && result.rows[0].role !== "owner") throw new HttpError(403,"Only the team owner can manage this team");
}
export async function validateScope(db: Sql, userId: string, teamId: string | null, folderId: string | null) {
  if(teamId||folderId) await requireOrganization(db,userId,teamId);
  if (teamId) await member(db,teamId,userId);
  if (folderId) {
    const result = await db.query("SELECT * FROM folders WHERE id=$1",[folderId]);
    const folder=result.rows[0];
    if (!folder || (folder.team_id ? folder.team_id !== teamId : folder.owner_id !== userId)) throw new HttpError(400,"Choose an accessible folder in the same team or personal space");
    if ((folder.team_id || null) !== teamId) throw new HttpError(400,"Folder and video must share the same visibility");
  }
}
export async function streamToken(runtime:Runtime,streamUid:string,exp:number,timeoutMs=20_000):Promise<string> {
  if(!runtime.env.CLOUDFLARE_ACCOUNT_ID||!runtime.env.CLOUDFLARE_API_TOKEN) throw new HttpError(503,"Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for hosted playback. Your original remains available");
  if(exp<=Math.floor(Date.now()/1000)) throw new HttpError(404,"Recording link unavailable");
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${runtime.env.CLOUDFLARE_ACCOUNT_ID}/stream/${streamUid}/token`,{method:"POST",headers:{Authorization:`Bearer ${runtime.env.CLOUDFLARE_API_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({exp,downloadable:false}),signal:AbortSignal.timeout(timeoutMs)});
  const result=await response.json() as {success:boolean;result?:{token:string}};
  if(!response.ok||!result?.success||typeof result.result?.token!=="string"||!result.result.token) throw new HttpError(502,"Stream playback token unavailable. Original recording remains available");
  return result.result.token;
}
export async function playbackJson(runtime:Runtime,streamUid:string|null,mediaUrl:string) {
  if(!streamUid) return {mediaUrl,streamUrl:null};
  const token=await streamToken(runtime,streamUid,Math.floor(Date.now()/1000)+300);
  return {mediaUrl,streamUrl:`https://iframe.videodelivery.net/${token}`};
}
export function videoJson(row: Record<string,any>, runtime: Runtime): Video {
  return {id:row.id,recordingId:row.recording_id,title:row.title,ownerId:row.owner_id,ownerName:row.owner_name,
    teamId:row.team_id,folderId:row.folder_id,durationMs:row.duration_ms,byteLength:Number(row.byte_length),mimeType:row.mime_type,
    uploadState:row.upload_state,processingStatus:row.processing_status,aiStatus:row.ai_status,createdAt:new Date(row.created_at).toISOString(),
    videoUrl:`${origin(runtime)}/videos/${row.id}`,mediaUrl:`/api/videos/${row.id}/media`,agentRunId:row.agent_run_id || null,chapters:chaptersJson(row.chapters,row.duration_ms,row.transcription_complete)};
}
export function commentJson(row: Record<string,any>): Comment {
  return {id:row.id,videoId:row.video_id,parentId:row.parent_id,body:row.deleted_at ? "" : row.body,positionMs:row.position_ms,
    authorId:row.author_id,authorName:row.author_name,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),
    deletedAt:row.deleted_at ? new Date(row.deleted_at).toISOString() : null,source:row.source,
    ...(row.source==="summary"?{summaryMoments:row.summary_moments||[]}: {})};
}
type CommentInput = {
  id?:string; parentId?:string|null; body:string; positionMs?:number; authorId:string|null;
  authorName:string; source:Comment["source"]; agentKey?:string; operationKey?:string;
};
export async function createComment(db:Sql,video:Record<string,any>,input:CommentInput) {
  let positionMs=input.positionMs;let parentAuthor:string|null=null;
  if(input.parentId) {
    const parent=(await db.query("SELECT * FROM comments WHERE id=$1 AND video_id=$2",[input.parentId,video.id])).rows[0];
    if(!parent||(parent.deleted_at&&input.source==="web")) throw new HttpError(400,"Reply target not found");
    if(positionMs===undefined) positionMs=parent.position_ms;parentAuthor=parent.author_id;
  }
  if(typeof positionMs!=="number"||!Number.isInteger(positionMs)||positionMs<0||positionMs>video.duration_ms) throw new HttpError(400,"Every comment needs a timestamp within the video");
  const text=input.body.trim();if(!text||text.length>10_000) throw new HttpError(400,"Write a comment or choose an emoji, up to 10000 characters");
  const inserted=await db.query("INSERT INTO comments(id,video_id,parent_id,author_id,author_name,body,position_ms,source,agent_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(agent_key) DO NOTHING RETURNING *",[input.id||uuid(),video.id,input.parentId||null,input.authorId,input.authorName,text,positionMs,input.source,input.agentKey||null]);
  if(!inserted.rows[0]) return (await db.query("SELECT * FROM comments WHERE agent_key=$1",[input.agentKey])).rows[0];
  const comment=inserted.rows[0];
  await recordEvent(db,video,{id:input.authorId,name:input.authorName},input.parentId?"reply":"comment",input.operationKey||`comment:${comment.id}`,text,positionMs,parentAuthor,comment.id);
  if(input.source!=="slack") await enqueue(db,"slack_comment",video.id,`slack:comment:${comment.id}`,{commentId:comment.id,action:"create",actorId:input.authorId||video.owner_id});
  await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);
  return comment;
}
export async function publishSummaryComment(db:Sql,videoId:string,summary:Summary) {
  const owner=(await db.query("SELECT owner_id FROM videos WHERE id=$1",[videoId])).rows[0];if(!owner) throw new HttpError(404,"Video not found");
  const video=await accessibleVideo(db,videoId,owner.owner_id,true);
  const existing=(await db.query("SELECT *,body=$2 AND summary_moments=$3::jsonb AS unchanged FROM comments WHERE video_id=$1 AND source='summary' AND parent_id IS NULL FOR UPDATE",[video.id,summary.text,JSON.stringify(summary.moments)])).rows[0];
  if(existing&&(!existing.summary_managed||existing.deleted_at)) return existing;
  if(existing) {
    if(existing.unchanged) return existing;
    const updated=(await db.query("UPDATE comments SET body=$2,summary_moments=$3,updated_at=now() WHERE id=$1 RETURNING *",[existing.id,summary.text,JSON.stringify(summary.moments)])).rows[0];
    await db.query("DELETE FROM search_records WHERE id=$1",[`comment:${existing.id}`]);
    await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);
    await enqueue(db,"slack_comment",video.id,`slack:summary:${existing.id}:${uuid()}`,{commentId:existing.id,action:"update",actorId:video.owner_id});
    return updated;
  }
  const created=await createComment(db,video,{id:`summary:${video.id}`,body:summary.text,positionMs:0,authorId:video.owner_id,authorName:video.owner_name,source:"summary"});
  return (await db.query("UPDATE comments SET summary_managed=true,summary_moments=$2 WHERE id=$1 RETURNING *",[created.id,JSON.stringify(summary.moments)])).rows[0];
}
export function activityJson(row: Record<string,any>, runtime: Runtime): Activity {
  return {id:row.id,kind:row.kind,videoId:row.video_id,videoTitle:row.video_title,actorName:row.actor_name,actorImage:row.actor_image??null,
    body:row.body,positionMs:row.position_ms,createdAt:new Date(row.created_at).toISOString(),videoUrl:`${origin(runtime)}/videos/${row.video_id}${row.position_ms==null?"":`?t=${row.position_ms}`}`};
}
export async function recordEvent(db: Sql, video: Record<string,any>, actor: {id:User["id"]|null;name:string}, kind: string, operationKey: string, body: string | null = null, positionMs: number | null = null, replyAuthor?: string | null, commentId?:string) {
  const id=uuid();
  const inserted=await db.query("INSERT INTO events(id,video_id,actor_id,actor_name,kind,operation_key,body,position_ms,comment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(operation_key) DO NOTHING RETURNING id",[id,video.id,actor.id,actor.name,kind,operationKey,body,positionMs,commentId||null]);
  if (!inserted.rowCount) return;
  await db.query(`INSERT INTO notifications(event_id,user_id)
    SELECT $1,recipient FROM (SELECT $2::text AS recipient UNION SELECT user_id FROM memberships WHERE team_id=$3 AND $4<>'view' UNION SELECT $5::text) people
    WHERE recipient IS NOT NULL AND recipient IS DISTINCT FROM $6 ON CONFLICT DO NOTHING`,[id,video.owner_id,video.team_id,kind,replyAuthor || null,actor.id]);
}
