import { createHash } from "node:crypto";
import { z } from "zod";
import { SHARED_MEETING_NOTE_MAX_BYTES, SHARED_MEETING_NOTE_OWNER_NAME_MAX_CHARS, sharedMeetingNoteInputSchema } from "../../shared/meeting-notes";
import type { SharedMeetingNote, SharedMeetingNoteInput, SharedMeetingNoteListItem, SharedNoteSegment } from "../../shared/meeting-notes";
import type { User } from "../../shared/contracts";
import { body, json } from "./http";
import { HttpError, transaction, uuid } from "./runtime";
import type { Runtime, Sql } from "./runtime";
import { validateScope } from "./domain";

type Row={id:string;owner_id:string;owner_name:string;client_meeting_id:string;team_id:string|null;team_name:string|null;folder_id:string|null;folder_name:string|null;title:string;notes_text:string;summary:string|null;transcript:SharedNoteSegment[];source_revision:string;source_created_at:Date;version:number;source_hash:string;created_at:Date;updated_at:Date;deleted_at:Date|null;notes_preview:string;summary_preview:string|null;transcript_segment_count:number;updated_key:string;rank:number};
const visible="n.deleted_at IS NULL AND (n.owner_id=$1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=n.team_id AND m.user_id=$1))";
const joins='FROM meeting_notes n JOIN "user" u ON u.id=n.owner_id LEFT JOIN teams t ON t.id=n.team_id LEFT JOIN folders f ON f.id=n.folder_id';
const ownerLabel=`CASE WHEN char_length(u.name)>${SHARED_MEETING_NOTE_OWNER_NAME_MAX_CHARS} THEN left(u.name,${SHARED_MEETING_NOTE_OWNER_NAME_MAX_CHARS-1})||'…' ELSE u.name END`;
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const querySchema=z.object({scope:z.enum(["feed","mine","team","folder"]).default("feed"),id:z.string().min(1).max(100).optional(),clientMeetingId:z.uuid().optional(),q:z.string().trim().min(1).max(300).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().max(2048).optional()});
const placementSchema=sharedMeetingNoteInputSchema.pick({teamId:true,folderId:true}).extend({expectedVersion:z.number().int().positive().max(2_147_483_647)});
const cursorSchema=z.strictObject({v:z.literal(1),filter:z.string().regex(/^[a-f0-9]{64}$/),id:z.uuid(),updatedAt:z.iso.datetime(),rank:z.number().finite().nonnegative()});
type Cursor=z.infer<typeof cursorSchema>;
function metadata(row:Row):Omit<SharedMeetingNote,"notesText"|"summary"|"transcript"> {
  return {id:row.id,clientMeetingId:row.client_meeting_id,teamId:row.team_id,folderId:row.folder_id,title:row.title,ownerId:row.owner_id,ownerName:row.owner_name,teamName:row.team_name,folderName:row.folder_name,sourceRevision:Number(row.source_revision),sourceCreatedAt:new Date(row.source_created_at).toISOString(),version:row.version,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}
function note(row:Row):SharedMeetingNote {return {...metadata(row),notesText:row.notes_text,summary:row.summary,transcript:row.transcript};}
function listItem(row:Row):SharedMeetingNoteListItem {return {...metadata(row),notesPreview:row.notes_preview,summaryPreview:row.summary_preview,transcriptSegmentCount:row.transcript_segment_count};}
async function accessible(db:Sql,id:string,userId:string):Promise<Row> {
  const row=(await db.query<Row>(`SELECT n.*,${ownerLabel} AS owner_name,t.name AS team_name,f.name AS folder_name ${joins} WHERE n.id=$2 AND ${visible}`,[userId,id])).rows[0];
  if(!row)throw new HttpError(404,"Shared meeting note not found");return row;
}
function readCursor(value:string|undefined,filter:string):Cursor|null {
  if(!value)return null;
  try {if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const cursor=cursorSchema.parse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));if(cursor.filter!==filter)throw new Error();return cursor;}
  catch {throw new HttpError(400,"Invalid meeting-note continuation. Reload the list.");}
}
async function list(runtime:Runtime,user:User,url:URL) {
  const input=querySchema.parse(Object.fromEntries(url.searchParams));
  if(input.scope==="team") {
    if(!input.id)throw new HttpError(400,"Choose a team");
    const allowed=await runtime.db.query("SELECT 1 FROM teams t WHERE t.id=$2 AND (EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=t.id AND m.user_id=$1) OR EXISTS(SELECT 1 FROM meeting_notes n WHERE n.team_id=t.id AND n.owner_id=$1 AND n.deleted_at IS NULL))",[user.id,input.id]);
    if(!allowed.rowCount)throw new HttpError(404,"Team not found");
  }
  if(input.scope==="folder") {
    if(!input.id)throw new HttpError(400,"Choose a folder");
    const allowed=await runtime.db.query("SELECT 1 FROM folders f WHERE f.id=$2 AND ((f.team_id IS NULL AND f.owner_id=$1) OR EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=f.team_id AND m.user_id=$1))",[user.id,input.id]);
    if(!allowed.rowCount)throw new HttpError(404,"Folder not found");
  }
  if(input.clientMeetingId&&input.scope!=="mine")throw new HttpError(400,"Use My notes to look up a source meeting");
  if(input.scope==="mine"&&input.clientMeetingId) {
    const removed=(await runtime.db.query<{version:number}>("SELECT version FROM meeting_notes WHERE owner_id=$1 AND client_meeting_id=$2 AND deleted_at IS NOT NULL",[user.id,input.clientMeetingId])).rows[0];
    if(removed)return {notes:[],nextCursor:null,removedVersion:removed.version};
  }
  const filter=digest({userId:user.id,scope:input.scope,team:input.id||null,client:input.clientMeetingId||null,q:input.q||null}),cursor=readCursor(input.cursor,filter);
  const rows=await runtime.db.query<Row>(`WITH search_query AS (
    SELECT CASE WHEN $5::text IS NULL THEN NULL::tsquery ELSE replace(plainto_tsquery('english',$5)::text,' & ',' | ')::tsquery END AS query
  ), selected AS (
    SELECT n.*,${ownerLabel} AS owner_name,t.name AS team_name,f.name AS folder_name,COALESCE(ts_rank_cd(n.search_document,search_query.query),0)::real AS rank
    ${joins} CROSS JOIN search_query WHERE ${visible} AND ($2<>'mine' OR n.owner_id=$1) AND ($2<>'team' OR n.team_id=$3)
      AND ($2<>'folder' OR n.folder_id=$3) AND ($4::text IS NULL OR n.client_meeting_id=$4) AND ($5::text IS NULL OR n.search_document@@search_query.query OR n.search_text ILIKE $6)
  ) SELECT id,owner_id,owner_name,client_meeting_id,team_id,team_name,folder_id,folder_name,title,source_revision,source_created_at,version,created_at,updated_at,
      left(notes_text,400) AS notes_preview,left(summary,600) AS summary_preview,jsonb_array_length(transcript) AS transcript_segment_count,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_key,rank
    FROM selected WHERE ($7::timestamptz IS NULL OR (rank,updated_at,id)<($8::real,$7::timestamptz,$9::text))
    ORDER BY rank DESC,updated_at DESC,id DESC LIMIT $10`,[user.id,input.scope,input.id||null,input.clientMeetingId||null,input.q||null,input.q?`%${input.q.replace(/[\\%_]/g,"\\$&")}%`:null,cursor?.updatedAt||null,cursor?.rank||0,cursor?.id||null,input.limit+1]);
  const notes:SharedMeetingNoteListItem[]=[];let size=128;
  for(const row of rows.rows.slice(0,input.limit)) {const item=listItem(row),bytes=Buffer.byteLength(JSON.stringify(item));if(size+bytes>SHARED_MEETING_NOTE_MAX_BYTES)break;notes.push(item);size+=bytes+1;}
  if(!notes.length&&rows.rows.length)throw new HttpError(413,"Shared-note metadata exceeds the response limit. Ask the server owner to shorten the account or team names.");
  const last=rows.rows[notes.length-1];
  const result={notes,nextCursor:last&&rows.rows.length>notes.length?Buffer.from(JSON.stringify({v:1,filter,id:last.id,updatedAt:last.updated_key,rank:Number(last.rank)})).toString("base64url"):null};
  if(Buffer.byteLength(JSON.stringify(result))>SHARED_MEETING_NOTE_MAX_BYTES)throw new HttpError(413,"This note list exceeds the response limit. Request fewer items per page.");
  return result;
}
async function placement(db:Sql,userId:string,teamId:string|null,folderId:string|null):Promise<void> {
  if(teamId) {
    const membership=await db.query("SELECT 1 FROM memberships WHERE team_id=$1 AND user_id=$2 FOR KEY SHARE",[teamId,userId]);
    if(!membership.rowCount)throw new HttpError(404,"Team not found");
  }
  if(folderId) {
    const folder=(await db.query<{team_id:string|null}>("SELECT f.team_id FROM folders f WHERE f.id=$2 AND ((f.team_id IS NULL AND f.owner_id=$1) OR EXISTS(SELECT 1 FROM memberships m WHERE m.team_id=f.team_id AND m.user_id=$1)) FOR SHARE OF f",[userId,folderId])).rows[0];
    if(!folder)throw new HttpError(404,"Folder not found");
    if(folder.team_id!==teamId)throw new HttpError(400,"The folder and note must have the same team or personal visibility");
  }
  await validateScope(db,userId,teamId,folderId);
}
async function publish(runtime:Runtime,user:User,input:SharedMeetingNoteInput):Promise<SharedMeetingNote> {
  const {expectedVersion,...snapshot}=input;snapshot.sourceCreatedAt=new Date(snapshot.sourceCreatedAt).toISOString();
  const sourceHash=digest(snapshot),searchText=[snapshot.title,snapshot.notesText,...snapshot.transcript.map(segment=>segment.text)].join("\n");
  return transaction(runtime.db,async db=>{
    await placement(db,user.id,snapshot.teamId,snapshot.folderId);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify([user.id,snapshot.clientMeetingId])]);
    const previous=(await db.query<Row>("SELECT * FROM meeting_notes WHERE owner_id=$1 AND client_meeting_id=$2 FOR UPDATE",[user.id,snapshot.clientMeetingId])).rows[0];
    if(previous?.deleted_at&&expectedVersion!==previous.version)throw new HttpError(409,"This shared copy was removed. Reload its version and confirm sharing again.");
    if(previous&&!previous.deleted_at&&previous.source_hash===sourceHash)return note(await accessible(db,previous.id,user.id));
    if(previous&&(new Date(previous.source_created_at).toISOString()!==snapshot.sourceCreatedAt||snapshot.sourceRevision<Number(previous.source_revision)))throw new HttpError(409,"The source identity or revision is stale. Reload the source note before sharing.");
    if(previous?expectedVersion!==previous.version:expectedVersion!==null)throw new HttpError(409,"The shared note changed. Reload its current version and confirm sharing again.");
    const id=previous?.id||uuid();
    const values=[id,user.id,snapshot.clientMeetingId,snapshot.teamId,snapshot.folderId,snapshot.title,snapshot.notesText,snapshot.summary,JSON.stringify(snapshot.transcript),snapshot.sourceRevision,snapshot.sourceCreatedAt,sourceHash,searchText];
    if(previous)await db.query("UPDATE meeting_notes SET team_id=$4,folder_id=$5,title=$6,notes_text=$7,summary=$8,transcript=$9::jsonb,source_revision=$10,source_hash=$12,search_text=$13,version=version+1,updated_at=now(),deleted_at=NULL WHERE id=$1 AND owner_id=$2 AND client_meeting_id=$3 AND source_created_at=$11",values);
    else await db.query("INSERT INTO meeting_notes(id,owner_id,client_meeting_id,team_id,folder_id,title,notes_text,summary,transcript,source_revision,source_created_at,source_hash,search_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)",values);
    return note(await accessible(db,id,user.id));
  });
}
export async function meetingNotesApi(request:Request,runtime:Runtime,user:User):Promise<Response|null> {
  const url=new URL(request.url),collection=url.pathname==="/api/meeting-notes",match=/^\/api\/meeting-notes\/([^/]+)$/.exec(url.pathname);
  if(!collection&&!match)return null;
  if(collection&&request.method==="GET")return json(await list(runtime,user,url));
  if(collection&&request.method==="POST") {
    const input=await body(request,sharedMeetingNoteInputSchema,SHARED_MEETING_NOTE_MAX_BYTES).catch(error=>{
      if(error instanceof HttpError&&error.status===413)throw new HttpError(413,"The snapshot exceeds 900000 UTF-8 bytes. Shorten the note or transcript before sharing. No source was truncated.");
      throw error;
    });return json({note:await publish(runtime,user,input)});
  }
  if(match) {
    const id=z.uuid().parse(match[1]);const current=await accessible(runtime.db,id,user.id);
    if(request.method==="GET")return json({note:note(current)});
    if(request.method==="PATCH") {
      if(current.owner_id!==user.id)throw new HttpError(403,"Only the note owner can move the shared copy");
      const input=await body(request,placementSchema);
      const moved=await transaction(runtime.db,async db=>{
        const locked=(await db.query<Row>("SELECT * FROM meeting_notes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE",[id,user.id])).rows[0];
        if(!locked)throw new HttpError(404,"Shared meeting note not found");
        await placement(db,user.id,input.teamId,input.folderId);
        if(locked.team_id===input.teamId&&locked.folder_id===input.folderId)return note(await accessible(db,id,user.id));
        if(locked.version!==input.expectedVersion)throw new HttpError(409,"The shared note changed. Reload its current version before moving it.");
        const snapshot={clientMeetingId:locked.client_meeting_id,teamId:input.teamId,folderId:input.folderId,title:locked.title,notesText:locked.notes_text,summary:locked.summary,transcript:sharedMeetingNoteInputSchema.shape.transcript.parse(locked.transcript),sourceRevision:Number(locked.source_revision),sourceCreatedAt:new Date(locked.source_created_at).toISOString()};
        await db.query("UPDATE meeting_notes SET team_id=$2,folder_id=$3,source_hash=$4,version=version+1,updated_at=now() WHERE id=$1",[id,input.teamId,input.folderId,digest(snapshot)]);
        return note(await accessible(db,id,user.id));
      });return json({note:moved});
    }
    if(request.method==="DELETE") {
      if(current.owner_id!==user.id)throw new HttpError(403,"Only the note owner can remove the shared copy");
      await runtime.db.query("UPDATE meeting_notes SET deleted_at=now(),updated_at=now(),version=version+1,title='',notes_text='',summary=NULL,transcript='[]'::jsonb,search_text='',source_hash='' WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",[id,user.id]);
      return json({deleted:true});
    }
  }
  throw new HttpError(405,"Method not allowed");
}
