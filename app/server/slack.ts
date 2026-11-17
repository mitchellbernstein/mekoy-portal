import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { User } from "../../shared/contracts";
import { accessibleVideo, createComment, member, recordEvent } from "./domain";
import { enqueue, HttpError, origin, transaction, uuid } from "./runtime";
import type { Runtime } from "./runtime";
import { requireOrganization } from "./entitlements";
import { readBody } from "./http";

const scopes="chat:write,channels:read,groups:read,channels:history,groups:history,reactions:read,users:read,users:read.email,metadata.message:read";
type Installation={id:string;team_id:string;slack_team_id:string;bot_user_id:string;access_token:string;status:string};
export class ProviderError extends Error {
  constructor(message:string,public uncertain=false,public retryAfter=0,public blocked=false) {super(message);}
}
export async function encrypt(runtime:Runtime,value:string,decrypt=false) {
  const raw=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(runtime.env.BETTER_AUTH_SECRET));
  const key=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt","decrypt"]);
  if(decrypt) {const bytes=Buffer.from(value,"base64");return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.subarray(0,12)},key,bytes.subarray(12)));}
  const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value));
  return Buffer.concat([iv,Buffer.from(ciphertext)]).toString("base64");
}
async function slack(runtime:Runtime,installation:Installation,method:string,payload:Record<string,unknown>,write=false):Promise<any> {
  let response:Response;
  try {response=await fetch(`https://slack.com/api/${method}`,{method:"POST",headers:{Authorization:`Bearer ${await encrypt(runtime,installation.access_token,true)}`,"Content-Type":"application/json; charset=utf-8"},body:JSON.stringify(payload),signal:AbortSignal.timeout(20_000)});}
  catch {throw new ProviderError(`Slack ${method} did not return a receipt`,write);}
  if(response.status===429) throw new ProviderError("Slack rate limit. Waiting for Retry-After",false,Math.max(1,Number(response.headers.get("retry-after"))||30));
  if(response.status>=500) throw new ProviderError(`Slack ${method} returned ${response.status}`,write);
  const result=await response.json() as any;
  if(!response.ok||!result.ok) {
    const error=String(result.error||response.status);
    const blocked=["token_revoked","invalid_auth","account_inactive","missing_scope","not_in_channel","channel_not_found","is_archived"].includes(error);
    if(["token_revoked","invalid_auth","account_inactive","missing_scope"].includes(error)) await runtime.db.query("UPDATE slack_installations SET status='error',error=$2 WHERE id=$1",[installation.id,`Slack ${error}. Reconnect this workspace`]);
    throw new ProviderError(`Slack ${error}`,false,0,blocked);
  }
  return result;
}
function configured(runtime:Runtime) {
  if(!runtime.env.SLACK_CLIENT_ID||!runtime.env.SLACK_CLIENT_SECRET||!runtime.env.SLACK_SIGNING_SECRET) throw new HttpError(503,"Slack needs server setup. Ask the workspace owner to configure it");
}
export async function slackConnect(request:Request,runtime:Runtime,user:User) {
  const teamId=new URL(request.url).searchParams.get("teamId");if(!teamId) throw new HttpError(400,"Choose a team to connect");
  await requireOrganization(runtime.db,user.id,teamId);
  await member(runtime.db,teamId,user.id);
  configured(runtime);
  const team=(await runtime.db.query("SELECT owner_id FROM teams WHERE id=$1",[teamId])).rows[0];
  const exists=(await runtime.db.query("SELECT id FROM slack_installations WHERE team_id=$1",[teamId])).rows[0];
  if(!exists&&team.owner_id!==user.id) throw new HttpError(403,"Team owner needs to install Slack first");
  const state=uuid()+uuid();
  await runtime.db.query("INSERT INTO oauth_states(token_hash,user_id,team_id,expires_at,purpose) VALUES($1,$2,$3,now()+interval '10 minutes',$4)",[createHash("sha256").update(state).digest("hex"),user.id,teamId,team.owner_id===user.id?"install":"link"]);
  const url=new URL("https://slack.com/oauth/v2/authorize");url.searchParams.set("client_id",runtime.env.SLACK_CLIENT_ID!);url.searchParams.set("scope",scopes);url.searchParams.set("state",state);url.searchParams.set("redirect_uri",`${origin(runtime)}/api/slack/callback`);
  return Response.redirect(url.toString(),302);
}
export async function slackCallback(request:Request,runtime:Runtime,user:User) {
  configured(runtime);const url=new URL(request.url);const state=url.searchParams.get("state");const code=url.searchParams.get("code");
  if(!state||!code) throw new HttpError(400,"Slack did not return a consent code. Try connecting again");
  const consumed=await runtime.db.query("DELETE FROM oauth_states WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() AND purpose IN ('install','link') RETURNING *",[createHash("sha256").update(state).digest("hex"),user.id]);
  const pending=consumed.rows[0];if(!pending) throw new HttpError(400,"Slack connection expired or belongs to another account. Connect again");
  await member(runtime.db,pending.team_id,user.id,pending.purpose==="install");
  await requireOrganization(runtime.db,user.id,pending.team_id);
  const response=await fetch("https://slack.com/api/oauth.v2.access",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:runtime.env.SLACK_CLIENT_ID!,client_secret:runtime.env.SLACK_CLIENT_SECRET!,code,redirect_uri:`${origin(runtime)}/api/slack/callback`}),signal:AbortSignal.timeout(20_000)});
  const grant=await response.json() as any;
  if(!response.ok||!grant.ok||!grant.access_token||!grant.team?.id||!grant.authed_user?.id||!grant.bot_user_id) throw new HttpError(502,`Slack connection failed: ${String(grant.error||"missing verified grant")}`);
  const granted=new Set(String(grant.scope||"").split(","));if(scopes.split(",").some(scope=>!granted.has(scope))) throw new HttpError(400,"Slack did not grant the required read and write permissions. Reinstall with the supplied manifest");
  await transaction(runtime.db,async db=>{
    let installation=(await db.query("SELECT * FROM slack_installations WHERE team_id=$1",[pending.team_id])).rows[0];
    if(installation&&installation.slack_team_id!==grant.team.id) throw new HttpError(409,"This team is connected to another Slack workspace");
    if(pending.purpose==="install") {
      const token=await encrypt(runtime,grant.access_token);
      installation=(await db.query("INSERT INTO slack_installations(id,team_id,slack_team_id,installed_by,bot_user_id,access_token,scopes) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(team_id) DO UPDATE SET access_token=excluded.access_token,scopes=excluded.scopes,bot_user_id=excluded.bot_user_id,status='connected',error=NULL RETURNING *",[uuid(),pending.team_id,grant.team.id,user.id,grant.bot_user_id,token,grant.scope])).rows[0];
    }
    if(!installation) throw new HttpError(409,"Team owner needs to connect this workspace first");
    await db.query("INSERT INTO slack_identities(installation_id,slack_user_id,user_id) VALUES($1,$2,$3) ON CONFLICT(installation_id,slack_user_id) DO UPDATE SET user_id=excluded.user_id",[installation.id,grant.authed_user.id,user.id]);
  });
  return Response.redirect(`${origin(runtime)}/teams/${pending.team_id}`,302);
}
export async function shareSlack(runtime:Runtime,user:User,video:any,channelId:string) {
  await requireOrganization(runtime.db,user.id,video.team_id);
  if(!video.team_id) throw new HttpError(400,"Move this video to a team before sharing to Slack");
  await member(runtime.db,video.team_id,user.id,true);
  configured(runtime);
  const installation=(await runtime.db.query("SELECT * FROM slack_installations WHERE team_id=$1",[video.team_id])).rows[0];
  if(!installation||installation.status!=="connected") throw new HttpError(409,"Connect or reconnect this team's Slack workspace first");
  const existing=(await runtime.db.query("SELECT * FROM slack_threads WHERE video_id=$1",[video.id])).rows[0];
  if(existing) {if(existing.channel_id!==channelId) throw new HttpError(409,"This video already has a Slack thread in another channel");return {status:"shared",threadUrl:existing.thread_url};}
  const job=await transaction(runtime.db,async db=>{
    const locked=await accessibleVideo(db,video.id,user.id,true);
    const active=(await db.query("SELECT * FROM jobs WHERE video_id=$1 AND kind='slack_share' AND status<>'succeeded' AND payload->>'generation'=$2 ORDER BY created_at DESC LIMIT 1",[video.id,String(locked.slack_generation)])).rows[0];
    if(active) return active;
    const jobId=await enqueue(db,"slack_share",video.id,`slack:share:${video.id}:${uuid()}`,{channelId,actorId:user.id,installationId:installation.id,generation:locked.slack_generation});
    return (await db.query("SELECT * FROM jobs WHERE id=$1",[jobId])).rows[0];
  });
  if(job.payload.channelId!==channelId) throw new HttpError(409,"A share operation already targets another channel");
  if(job.status==="blocked"||job.status==="error") await runtime.db.query("UPDATE jobs SET status='pending',available_at=now(),error=NULL WHERE id=$1",[job.id]);
  return {status:job.status==="uncertain"?"uncertain. Waiting to reconcile Slack's receipt":"queued"};
}
export async function slackEvents(request:Request,runtime:Runtime) {
  const secret=runtime.env.SLACK_SIGNING_SECRET;const stamp=request.headers.get("x-slack-request-timestamp")||"";const signature=request.headers.get("x-slack-signature")||"";
  if(!secret||!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>300) throw new HttpError(401,"Invalid or expired Slack signature");
  const bytes=await readBody(request,1_000_000);
  const expected=`v0=${createHmac("sha256",secret).update(`v0:${stamp}:`).update(bytes).digest("hex")}`;
  if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) throw new HttpError(401,"Invalid Slack signature");
  const raw=new TextDecoder().decode(bytes);
  let payload:any;try {payload=JSON.parse(raw);} catch {throw new HttpError(400,"Invalid Slack event JSON");}
  if(payload.type==="url_verification") return Response.json({challenge:payload.challenge});
  if(payload.type!=="event_callback"||typeof payload.event_id!=="string"||typeof payload.team_id!=="string") return Response.json({accepted:false});
  await transaction(runtime.db,async db=>{
    const installations=await db.query("SELECT * FROM slack_installations WHERE slack_team_id=$1",[payload.team_id]);
    for(const installation of installations.rows) {
      const key=`${payload.event_id}:${installation.id}`;
      const saved=await db.query("INSERT INTO slack_inbox(event_id,installation_id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",[key,installation.id,JSON.stringify(payload)]);
      if(saved.rowCount) await enqueue(db,"slack_inbound",null,`slack:inbound:${key}`,{eventId:key});
    }
  });
  return Response.json({accepted:true});
}
function timestamp(text:string,duration:number) {
  const explicit=/(?:^\s*|\[|\bat\s+)(?:(\d+):)?(\d{1,2}):([0-5]\d)(?:\]|\b)/i.exec(text);
  if(!explicit) return null;const ms=((Number(explicit[1]||0)*3600)+(Number(explicit[2])*60)+Number(explicit[3]))*1000;
  return ms<=duration?ms:null;
}
async function inbound(runtime:Runtime,job:any) {
  return transaction(runtime.db,async db=>{
    const inbox=(await db.query("SELECT * FROM slack_inbox WHERE event_id=$1",[job.payload.eventId])).rows[0];if(!inbox) return {ignored:"missing event"};
    const installation=(await db.query("SELECT * FROM slack_installations WHERE id=$1",[inbox.installation_id])).rows[0] as Installation;
    const event=inbox.payload.event;if(!event) return {ignored:"no event"};
    if(event.type==="app_uninstalled"||event.type==="tokens_revoked") {await db.query("UPDATE slack_installations SET status='error',error='Slack installation revoked. Reconnect this team' WHERE id=$1",[installation.id]);return {revoked:true};}
    const channelId=event.channel||event.item?.channel;let message=event.message||event;
    const messageTs=event.deleted_ts||message.ts||event.item?.ts;
    if(typeof channelId!=="string"||typeof messageTs!=="string") return {ignored:"missing channel or timestamp"};
    const revision=String(event.event_ts||event.ts||message.edited?.ts||message.ts||"");
    if(!/^\d+\.\d+$/.test(revision)) return {ignored:"missing provider revision"};
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${installation.id}:${channelId}:${messageTs}`]);
    const mapping=(await db.query("SELECT * FROM slack_messages WHERE installation_id=$1 AND channel_id=$2 AND message_ts=$3",[installation.id,channelId,messageTs])).rows[0];
    if((event.user||message.user)===installation.bot_user_id||(event.type==="message"&&(message.bot_id||message.subtype==="bot_message"||mapping?.exported))) return {ignored:"app echo"};
    let canonicalDeleted=false;
    if(event.type==="message") {
      const changed=await db.query("INSERT INTO slack_message_versions(installation_id,channel_id,message_ts,revision_ts,deleted,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id,channel_id,message_ts) DO UPDATE SET revision_ts=excluded.revision_ts,deleted=excluded.deleted,payload=excluded.payload WHERE NOT slack_message_versions.deleted AND slack_message_versions.revision_ts::numeric<excluded.revision_ts::numeric RETURNING revision_ts",[installation.id,channelId,messageTs,revision,event.subtype==="message_deleted",JSON.stringify(message)]);
      const canonical=(await db.query("SELECT * FROM slack_message_versions WHERE installation_id=$1 AND channel_id=$2 AND message_ts=$3",[installation.id,channelId,messageTs])).rows[0];
      canonicalDeleted=canonical.deleted;
      if(!changed.rowCount&&mapping&&!canonicalDeleted) return {ignored:"stale message revision"};
      message=canonical.payload;
    }
    const threadTs=message.thread_ts||event.previous_message?.thread_ts||messageTs;
    const thread=(await db.query("SELECT * FROM slack_threads WHERE installation_id=$1 AND channel_id=$2 AND (root_ts=$3 OR video_id=$4)",[installation.id,channelId,threadTs,mapping?.video_id||null])).rows[0];
    if((thread||mapping)&&!(await db.query("SELECT id FROM videos WHERE id=$1 AND deleted_at IS NULL",[thread?.video_id||mapping.video_id])).rowCount) return {ignored:"Video removed"};
    if(canonicalDeleted) {
      if(mapping?.comment_id) {
        await db.query("UPDATE comments SET body='',deleted_at=now(),updated_at=now() WHERE id=$1 AND source='slack'",[mapping.comment_id]);
        await db.query("DELETE FROM search_records WHERE id=$1",[`comment:${mapping.comment_id}`]);
        await enqueue(db,"index",mapping.video_id,`index:${mapping.video_id}:${uuid()}`);
      }
      return {deleted:true};
    }
    if(!thread) return {ignored:"unmapped thread"};
    const actorSlack=event.type==="message"?message.user:event.user;
    if(typeof actorSlack!=="string") return {ignored:"missing actor"};
    let reactionCommentId:string|null=null;
    if(event.type==="reaction_added"||event.type==="reaction_removed") {
      const current=await db.query("INSERT INTO slack_reaction_versions(installation_id,channel_id,message_ts,slack_user_id,emoji,revision_ts,active) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(installation_id,channel_id,message_ts,slack_user_id,emoji) DO UPDATE SET revision_ts=excluded.revision_ts,active=excluded.active WHERE slack_reaction_versions.revision_ts::numeric<excluded.revision_ts::numeric RETURNING comment_id",[installation.id,channelId,messageTs,actorSlack,String(event.reaction),revision,event.type==="reaction_added"]);
      if(!current.rowCount) return {ignored:"stale reaction revision"};
      reactionCommentId=current.rows[0].comment_id;
      if(event.type==="reaction_removed") {
        if(reactionCommentId) {
          await db.query("UPDATE comments SET deleted_at=now(),updated_at=now() WHERE id=$1 AND source='slack'",[reactionCommentId]);
          await db.query("DELETE FROM search_records WHERE id=$1",[`comment:${reactionCommentId}`]);
          await enqueue(db,"index",thread.video_id,`index:${thread.video_id}:${uuid()}`);
        }
        return {removed:true};
      }
      const deletedTarget=(await db.query("SELECT deleted FROM slack_message_versions WHERE installation_id=$1 AND channel_id=$2 AND message_ts=$3",[installation.id,channelId,messageTs])).rows[0];
      if(deletedTarget?.deleted) return {ignored:"Reaction target was deleted in Slack"};
    }
    const identity=(await db.query('SELECT u.id,u.name FROM slack_identities si JOIN "user" u ON u.id=si.user_id JOIN memberships m ON m.user_id=u.id AND m.team_id=$3 WHERE si.installation_id=$1 AND si.slack_user_id=$2',[installation.id,actorSlack,installation.team_id])).rows[0];
    if(!identity) {await db.query("UPDATE slack_threads SET error='A Slack participant needs to connect their app account and join this team before their discussion can synchronize' WHERE id=$1",[thread.id]);return {ignored:"unlinked or unauthorized Slack actor"};}
    const video=await accessibleVideo(db,thread.video_id,identity.id);if(video.team_id!==installation.team_id) return {ignored:"video changed teams"};
    if(event.type==="reaction_added") {
      const emoji=`:${event.reaction}:`;
      if(reactionCommentId) {
        await db.query("UPDATE comments SET body=$2,deleted_at=NULL,updated_at=now() WHERE id=$1 AND source='slack'",[reactionCommentId,emoji]);
        const restored=(await db.query("SELECT position_ms,parent_id FROM comments WHERE id=$1",[reactionCommentId])).rows[0];
        await recordEvent(db,video,identity,restored.parent_id?"reply":"comment",`slack:reaction:${inbox.event_id}`,emoji,restored.position_ms,null,reactionCommentId);
        await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);
      } else {
        const comment=await createComment(db,video,{body:emoji,positionMs:mapping?.comment_id?undefined:0,parentId:mapping?.comment_id||null,authorId:identity.id,authorName:identity.name,source:"slack",operationKey:`slack:reaction:${inbox.event_id}`});
        await db.query("UPDATE comments SET slack_user_id=$2 WHERE id=$1",[comment.id,actorSlack]);
        await db.query("UPDATE slack_reaction_versions SET comment_id=$6 WHERE installation_id=$1 AND channel_id=$2 AND message_ts=$3 AND slack_user_id=$4 AND emoji=$5",[installation.id,channelId,messageTs,actorSlack,String(event.reaction),comment.id]);
      }
      return {comment:true};
    }
    if(event.type!=="message"||thread.root_ts===message.ts) return {ignored:"not a comment"};
    const text=String(message.text||"").slice(0,10_000);if(!text.trim()) return {ignored:"empty text"};
    const at=timestamp(text,video.duration_ms)??0;
    if(mapping?.comment_id) {
      const updated=await db.query("UPDATE comments SET body=$2,position_ms=$3,updated_at=now() WHERE id=$1 AND slack_user_id=$4 AND source='slack' RETURNING id",[mapping.comment_id,text,at,actorSlack]);
      if(updated.rowCount) await db.query("UPDATE events SET position_ms=$2 WHERE comment_id=$1",[mapping.comment_id,at]);
    }
    else {
      const parentMapping=message.thread_ts&&message.thread_ts!==thread.root_ts?(await db.query("SELECT comment_id FROM slack_messages WHERE installation_id=$1 AND channel_id=$2 AND message_ts=$3",[installation.id,channelId,message.thread_ts])).rows[0]:null;
      const comment=await createComment(db,video,{body:text,positionMs:at,parentId:parentMapping?.comment_id||null,authorId:identity.id,authorName:identity.name,source:"slack",operationKey:`slack:message:${inbox.event_id}`});
      await db.query("UPDATE comments SET slack_user_id=$2 WHERE id=$1",[comment.id,actorSlack]);
      await db.query("INSERT INTO slack_messages(installation_id,channel_id,message_ts,comment_id,video_id) VALUES($1,$2,$3,$4,$5)",[installation.id,channelId,messageTs,comment.id,video.id]);
    }
    if(mapping?.comment_id) await db.query("DELETE FROM search_records WHERE id=$1",[`comment:${mapping.comment_id}`]);
    await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);return {imported:true};
  });
}
function attributedComment(runtime:Runtime,video:any,comment:any) {
  const time=`[${Math.floor(comment.position_ms/60000)}:${String(Math.floor(comment.position_ms/1000)%60).padStart(2,"0")}] `;
  const link=`${origin(runtime)}/videos/${video.id}?t=${comment.position_ms}`;
  return `${escapeSlack(comment.author_name)}${comment.source==="summary"?" · AI-generated opening summary":""} in Video workspace\n${time}${escapeSlack(comment.body)}\n${link}`;
}
function escapeSlack(text:string) {return text.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}
async function reconcile(runtime:Runtime,installation:Installation,job:any,channelId:string,rootTs?:string) {
  if(job.external_id) return {ts:job.external_id};
  let cursor:string|undefined;let pages=0;
  do {
    const results=await slack(runtime,installation,rootTs?"conversations.replies":"conversations.history",{channel:channelId,...(rootTs?{ts:rootTs}:{oldest:String(new Date(job.created_at).getTime()/1000-60)}),limit:100,cursor,include_all_metadata:true});
    const found=results.messages?.find((message:any)=>message.metadata?.event_type==="video_workspace"&&message.metadata?.event_payload?.operationKey===job.operation_key&&message.user===installation.bot_user_id);
    if(found) return found;
    cursor=results.response_metadata?.next_cursor;pages++;
  } while(cursor&&pages<10);
  return null;
}
async function rememberReceipt(runtime:Runtime,job:any,ts:string) {
  if(!/^\d+\.\d+$/.test(ts)) throw new ProviderError("Slack returned an invalid message receipt",true);
  try {await runtime.db.query("UPDATE jobs SET external_id=$2,result=$3 WHERE id=$1",[job.id,ts,JSON.stringify({ts})]);}
  catch {throw new ProviderError("Slack returned a receipt but it could not be saved locally",true);}
}
export async function runSlackJob(runtime:Runtime,job:any):Promise<Record<string,unknown>> {
  if(job.kind==="slack_inbound") return inbound(runtime,job);
  const video=(await runtime.db.query("SELECT * FROM videos WHERE id=$1 AND deleted_at IS NULL",[job.video_id])).rows[0];if(!video) return {skipped:"Video removed"};if(!video.team_id) return {skipped:"personal video"};
  if(job.payload.generation!==undefined&&job.payload.generation!==video.slack_generation) return {skipped:"Owner disconnected this operation"};
  const actorId=job.payload.actorId;
  if(!actorId) throw new ProviderError("Slack operation has no authenticated actor",false,0,true);
  await member(runtime.db,video.team_id,actorId,job.kind==="slack_share");
  const installation=(await runtime.db.query("SELECT * FROM slack_installations WHERE team_id=$1",[video.team_id])).rows[0] as Installation;
  if(!installation) return {skipped:"Slack not connected"};
  if(installation.status!=="connected") throw new ProviderError("Reconnect Slack to resume synchronization",false,0,true);
  let thread=(await runtime.db.query("SELECT * FROM slack_threads WHERE video_id=$1",[video.id])).rows[0];
  if(job.kind!=="slack_share"&&!thread) return {skipped:"Video has no Slack thread"};
  const channel=thread?.channel_id||job.payload.channelId;
  if(job.kind==="slack_share"&&thread) return {ts:thread.root_ts,threadUrl:thread.thread_url};
  const metadata={event_type:"video_workspace",event_payload:{operationKey:job.operation_key,videoId:video.id}};
  let result:any;
  const uncertain=job.previous_status==="uncertain";
  if(job.kind==="slack_share") {
    result=await reconcile(runtime,installation,job,channel);
    if(!result&&uncertain) throw new ProviderError("Share receipt is still uncertain. Check Slack before explicitly retrying",true);
    if(!result) result=await slack(runtime,installation,"chat.postMessage",{channel,text:`${escapeSlack(video.title)}\n${origin(runtime)}/videos/${video.id}`,metadata,client_msg_id:job.id,unfurl_links:false,unfurl_media:false,parse:"none",link_names:false},true);
    await rememberReceipt(runtime,job,result.ts);
    const permalink=await slack(runtime,installation,"chat.getPermalink",{channel,message_ts:result.ts});
    await runtime.db.query("INSERT INTO slack_threads(id,video_id,installation_id,channel_id,root_ts,thread_url) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM videos WHERE id=$2 AND slack_generation=$7) ON CONFLICT(video_id) DO NOTHING",[uuid(),video.id,installation.id,channel,result.ts,permalink.permalink,video.slack_generation]);
    return {ts:result.ts,threadUrl:permalink.permalink};
  }
  if(job.kind==="slack_comment") {
    const comment=(await runtime.db.query("SELECT * FROM comments WHERE id=$1 AND video_id=$2",[job.payload.commentId,video.id])).rows[0];
    if(!comment||!["web","agent","summary"].includes(comment.source)) return {skipped:"Not a workspace comment"};
    let mapping=(await runtime.db.query("SELECT * FROM slack_messages WHERE comment_id=$1",[comment.id])).rows[0];
    const creation=(await runtime.db.query("SELECT * FROM jobs WHERE operation_key=$1",[`slack:comment:${comment.id}`])).rows[0];
    if(!mapping&&creation&&creation.id!==job.id) {
      if(creation.attempts===0) {if(comment.deleted_at) return {skipped:"Deleted before initial delivery"};throw new ProviderError("Waiting for the initial Slack comment delivery",false,10);}
      const delivered=await reconcile(runtime,installation,creation,channel,thread.root_ts);
      if(delivered) mapping={message_ts:delivered.ts};
      else if(["uncertain","running","retry"].includes(creation.status)) throw new ProviderError("Initial comment delivery is unresolved. Waiting for its receipt",true);
    }
    if(!mapping&&(uncertain||job.payload.action==="create")) {result=await reconcile(runtime,installation,job,channel,thread.root_ts);if(result) mapping={message_ts:result.ts};}
    if(mapping) {
      await runtime.db.query("INSERT INTO slack_messages(installation_id,channel_id,message_ts,comment_id,video_id,exported) SELECT $1,$2,$3,$4,$5,true WHERE EXISTS(SELECT 1 FROM slack_threads WHERE id=$6) ON CONFLICT(comment_id) DO NOTHING",[installation.id,channel,mapping.message_ts,comment.id,video.id,thread.id]);
      if(comment.deleted_at||job.payload.action==="delete") {
        try {await slack(runtime,installation,"chat.delete",{channel,ts:mapping.message_ts},true);} catch(error) {if(!(error instanceof ProviderError)||!error.message.includes("message_not_found")) throw error;}
        return {deleted:true,ts:mapping.message_ts};
      }
      await slack(runtime,installation,"chat.update",{channel,ts:mapping.message_ts,text:attributedComment(runtime,video,comment)},true);return {ts:mapping.message_ts};
    }
    if(uncertain) throw new ProviderError("Comment delivery is still uncertain. Check the Slack thread",true);
    if(comment.deleted_at||job.payload.action==="delete") return {skipped:"Comment deleted before export"};
    if(job.payload.action!=="create"&&!creation?.result?.skipped) throw new ProviderError("Waiting for initial comment mapping before applying this edit",false,10);
    const text=attributedComment(runtime,video,comment);
    if(!result) result=await slack(runtime,installation,"chat.postMessage",{channel,thread_ts:thread.root_ts,text,metadata,client_msg_id:job.id,unfurl_links:false,unfurl_media:false,parse:"none",link_names:false},true);
    await rememberReceipt(runtime,job,result.ts);
    try {await runtime.db.query("INSERT INTO slack_messages(installation_id,channel_id,message_ts,comment_id,video_id,exported) SELECT $1,$2,$3,$4,$5,true WHERE EXISTS(SELECT 1 FROM slack_threads WHERE id=$6) ON CONFLICT(comment_id) DO NOTHING",[installation.id,channel,result.ts,comment.id,video.id,thread.id]);}
    catch {throw new ProviderError("Slack returned a receipt but its local mapping could not be saved",true);}
    return {ts:result.ts};
  }
  throw new ProviderError("Unsupported Slack operation",false,0,true);
}
