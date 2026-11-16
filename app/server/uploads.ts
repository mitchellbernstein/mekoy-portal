import type { UploadInput, User } from "../../shared/contracts";
import { accessibleVideo, member, recordEvent, validateScope, videoJson } from "./domain";
import { enqueue, HttpError, origin, transaction, uuid } from "./runtime";
import type { Runtime, Sql } from "./runtime";
import { transcriptionProvider } from "./transcription";

async function uploadOwner(db: Sql, videoId: string, userId: string) {
  const row = await accessibleVideo(db, videoId, userId, true);
  if (row.owner_id !== userId) throw new HttpError(403, "Only the recording owner can upload");
  return row;
}

export async function prepareUpload(runtime: Runtime, user: User, input: UploadInput, request: Request, connection?:Sql,claim?:{runId:string;claimHash:string}) {
  const prepare = async (db:Sql) => {
    if(claim) {
      const authorized=(await db.query("SELECT team_id FROM agent_runs WHERE id=$1 AND claim_hash=$2 AND owner_id=$3 AND recording_id=$4 AND team_id=$5 AND status='running' AND lease_until>clock_timestamp() FOR SHARE",[claim.runId,claim.claimHash,user.id,input.recordingId,input.teamId||null])).rows[0];
      if(!authorized||input.folderId) throw new HttpError(409,"The retained runner claim does not authorize this recording and scope");
      await member(db,authorized.team_id,user.id,true);
    } else await validateScope(db, user.id, input.teamId || null, input.folderId || null);
    const videoId = uuid();
    const key = `originals/${user.id}/${videoId}.mp4`;
    await db.query("INSERT INTO videos(id,recording_id,owner_id,title,team_id,folder_id,mime_type,duration_ms,byte_length,storage_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(owner_id,recording_id) DO NOTHING", [videoId,input.recordingId,user.id,input.title,input.teamId || null,input.folderId || null,input.mimeType,input.durationMs,input.byteLength,key]);
    const existing = await db.query('SELECT v.*,u.name AS owner_name FROM videos v JOIN "user" u ON u.id=v.owner_id WHERE v.owner_id=$1 AND v.recording_id=$2 FOR UPDATE OF v', [user.id,input.recordingId]);
    const video = existing.rows[0];
    await accessibleVideo(db,video.id,user.id);
    if (Number(video.byte_length) !== input.byteLength || video.mime_type !== input.mimeType || video.duration_ms !== input.durationMs) throw new HttpError(409, "Recording UUID belongs to different media. Retry the original saved recording");
    return video;
  };
  const row=connection?await prepare(connection):await transaction(runtime.db,prepare);
  const instructions = row.upload_state === "uploaded" ? {url:`${origin(runtime)}/api/uploads/${row.id}/bytes`,headers:{"Content-Type":row.mime_type}} : await runtime.storage.prepare(row.storage_key,row.mime_type,Number(row.byte_length),request,row.id);
  return {video:videoJson(row,runtime),videoUrl:`${origin(runtime)}/videos/${row.id}`,completeUrl:`${origin(runtime)}/api/uploads/${row.id}/complete`,upload:{method:"PUT" as const,...instructions}};
}

export async function putUpload(runtime: Runtime, user: User, videoId: string, request: Request, connection?:Sql) {
  const store = async (db:Sql) => {
    const row = await uploadOwner(db,videoId,user.id);
    if (row.upload_state === "uploaded") throw new HttpError(409,"Recording already has a durable receipt");
    const stored = await runtime.storage.put(row.storage_key,request,Number(row.byte_length));
    await db.query("UPDATE videos SET received_bytes=$2,upload_sha256=$3 WHERE id=$1",[row.id,stored.byteLength,stored.sha256]);
    return {receivedBytes:stored.byteLength};
  };
  return connection?store(connection):transaction(runtime.db,store);
}

export async function completeUpload(runtime: Runtime, user: User, videoId: string, expectedSha256?: string, connection?:Sql) {
  const finish = async (db:Sql) => {
    const row = await uploadOwner(db,videoId,user.id);
    if (expectedSha256 && row.upload_sha256 && row.upload_sha256!==expectedSha256) throw new HttpError(409,"Uploaded bytes do not match the retained demo. Restore the original before retrying");
    if(row.upload_state==="uploaded"&&!row.upload_sha256) {
      const verified=await runtime.storage.head(row.storage_key);
      if(!verified?.sha256) throw new HttpError(409,"Storage has not confirmed this recording checksum. Retry the retained original");
      if(expectedSha256&&verified.sha256!==expectedSha256) throw new HttpError(409,"Stored bytes do not match the retained demo");
      await db.query("UPDATE videos SET upload_sha256=$2 WHERE id=$1",[row.id,verified.sha256]);row.upload_sha256=verified.sha256;
    }
    if (row.upload_state !== "uploaded") {
      let head = await runtime.storage.head(row.storage_key);
      if (!head || head.byteLength !== Number(row.byte_length)) throw new HttpError(409,"Upload is incomplete. Retry the saved recording");
      const verifiedSha256=head.sha256||row.upload_sha256;
      if(!verifiedSha256) throw new HttpError(409,"Storage has not confirmed this recording checksum. Retry the retained original");
      if(expectedSha256&&verifiedSha256!==expectedSha256) throw new HttpError(409,"Stored bytes do not match the retained demo. Retry the original file");
      const receiptId = uuid();
      let finalKey = row.storage_key;
      if (runtime.storage.seal) { finalKey=`durable/${user.id}/${receiptId}.mp4`; head=await runtime.storage.seal(row.storage_key,finalKey,{...head,sha256:verifiedSha256});
        if(head.byteLength!==Number(row.byte_length)||head.sha256!==verifiedSha256) throw new HttpError(409,"Durable storage did not confirm the exact original recording"); }
      row.ai_status=transcriptionProvider(runtime)?"pending":"not_configured";
      await db.query("UPDATE videos SET upload_state='uploaded',received_bytes=$2,storage_key=$3,storage_etag=$4,receipt_id=$5,processing_status='playable',ai_status=$6,upload_sha256=$7 WHERE id=$1",[row.id,head.byteLength,finalKey,head.etag || null,receiptId,row.ai_status,verifiedSha256]);
      row.upload_state="uploaded"; row.receipt_id=receiptId; row.processing_status="playable";row.upload_sha256=verifiedSha256;
      await recordEvent(db,row,row.agent_run_id ? {id:null,name:"Demo agent"} : user,"video",`uploaded:${row.id}`,row.title);
      if(runtime.storage.kind==="r2"&&runtime.env.CLOUDFLARE_API_TOKEN&&runtime.env.CLOUDFLARE_ACCOUNT_ID) await enqueue(db,"stream",row.id,`stream:${row.id}`);
      await enqueue(db,"process",row.id,`process:${row.id}`);
      await enqueue(db,"feedback",row.id,`feedback:${row.id}`);
    }
    return {video:videoJson(row,runtime),receipt:{id:row.receipt_id,recordingId:row.recording_id,byteLength:Number(row.byte_length),sha256:row.upload_sha256,durable:true as const}};
  };
  return connection?finish(connection):transaction(runtime.db,finish);
}
