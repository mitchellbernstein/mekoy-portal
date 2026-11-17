import { z } from "zod";
import { currentUser, enqueue, HttpError, origin, transaction, uuid } from "./runtime";
import type { Runtime } from "./runtime";
import { accessibleVideo, activityJson, commentJson, createComment, member, playbackJson, recordEvent, validateScope, videoJson, visible } from "./domain";
import { slackCallback, slackConnect, slackEvents, shareSlack, ProviderError } from "./slack";
import { answerWorkspace, searchWorkspace } from "./search";
import { body, json, readBody } from "./http";
import { prepareUpload, putUpload, completeUpload } from "./uploads";
import { agentApi, agentPublic } from "./agents";
import { handleMcp } from "./mcp";
import { loadBootstrap } from "./bootstrap";
import { requireOrganization } from "./entitlements";
import { publicShare, readShareLink, revokeShareLink, revokeVideoLink, shareLink } from "./sharing";
import { meetingNotesApi } from "./meeting-notes";
import { servePreview } from "./preview";
import { transcriptionProvider, transcriptionSetup } from "./transcription";
import { teamMembershipApi } from "./team-membership";

const id=z.string().min(1).max(100);
const position=z.number().int().min(0).max(86_400_000).optional();
const uploadSchema=z.object({recordingId:z.uuid(),title:z.string().trim().min(1).max(240),mimeType:z.enum(["video/mp4","video/quicktime","video/webm"]),
  byteLength:z.number().int().positive().max(4_900_000_000),durationMs:z.number().int().min(0).max(86_400_000),teamId:id.nullable().optional(),folderId:id.nullable().optional()}).strict();
export async function handleApi(request:Request,runtime:Runtime):Promise<Response> {
  try {
    const url=new URL(request.url);const path=url.pathname;const method=request.method;
    if(path==="/api/mcp") return await handleMcp(request,runtime);
    if(path==="/api/health") {await runtime.db.query("SELECT 1");return json({status:"ok",storage:runtime.storage.kind});}
    if(path.startsWith("/api/auth/")) {
      const bounded=request.body?new Request(request,{body:await readBody(request)}):request;
      return await runtime.auth.handler(bounded);
    }
    if(path==="/api/slack/events"&&method==="POST") return await slackEvents(request,runtime);
    const publicAgentResponse=await agentPublic(request,runtime);if(publicAgentResponse) return publicAgentResponse;
    const sharedResponse=await publicShare(request,runtime);if(sharedResponse) return sharedResponse;
    const user=await currentUser(request,runtime);
    if(!["GET","HEAD"].includes(method)) {
      const from=request.headers.get("origin");
      if(from ? from!==origin(runtime) : !request.headers.get("authorization")?.startsWith("Bearer ")) throw new HttpError(403,"Request origin is not allowed");
    }
    const agentResponse=await agentApi(request,runtime,user);if(agentResponse) return agentResponse;
    const meetingNoteResponse=await meetingNotesApi(request,runtime,user);if(meetingNoteResponse)return meetingNoteResponse;
    const membershipResponse=await teamMembershipApi(request,runtime,user);if(membershipResponse)return membershipResponse;
    if(path==="/api/me"&&method==="GET") return json({user});
    if(path==="/api/bootstrap"&&method==="GET") return json(await loadBootstrap(runtime,user));
    if((path==="/api/activity"||path==="/api/feed")&&method==="GET") {
      const notification=path==="/api/activity";
      const teamId=url.searchParams.get("teamId");if(teamId) await member(runtime.db,teamId,user.id);
      const rows=await runtime.db.query(`SELECT e.*,v.title AS video_title,actor.image AS actor_image,CASE WHEN c.deleted_at IS NOT NULL THEN NULL WHEN c.id IS NOT NULL THEN c.body ELSE e.body END AS body FROM events e JOIN videos v ON v.id=e.video_id LEFT JOIN "user" actor ON actor.id=e.actor_id LEFT JOIN comments c ON c.id=e.comment_id ${notification?"JOIN notifications n ON n.event_id=e.id AND n.user_id=$1":""}
        WHERE ${visible()} AND ($2::text IS NULL OR v.team_id=$2) ORDER BY e.created_at DESC LIMIT 100`,[user.id,teamId]);
      const activity=rows.rows.map(row=>activityJson(row,runtime));
      if(notification) return json({activity});
      const posts=await runtime.db.query(`WITH recent AS (
        SELECT v.*,u.name AS owner_name FROM videos v JOIN "user" u ON u.id=v.owner_id
        WHERE ${visible()} AND v.upload_state='uploaded' AND ($2::text IS NULL OR v.team_id=$2)
        ORDER BY v.created_at DESC,v.id DESC LIMIT 20
      ) SELECT recent.*,discussion.comments FROM recent LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(c) ORDER BY (c.source='summary' AND c.parent_id IS NULL) DESC,c.created_at,c.id) AS comments
        FROM comments c WHERE c.video_id=recent.id
      ) discussion ON true ORDER BY recent.created_at DESC,recent.id DESC`,[user.id,teamId]);
      return json({activity,posts:posts.rows.map(row=>({video:videoJson(row,runtime),comments:(row.comments||[]).map(commentJson)}))});
    }
    if(path==="/api/teams"&&method==="POST") {
      const input=await body(request,z.object({name:z.string().trim().min(1).max(120)}).strict());
      await requireOrganization(runtime.db,user.id);
      const team=await transaction(runtime.db,async db=>{const teamId=uuid();await db.query("INSERT INTO teams(id,name,owner_id) VALUES($1,$2,$3)",[teamId,input.name,user.id]);await db.query("INSERT INTO memberships(team_id,user_id,role) VALUES($1,$2,'owner')",[teamId,user.id]);return {id:teamId,name:input.name,role:"owner"};});
      return json({team});
    }
    if(path==="/api/folders"&&method==="POST") {
      const input=await body(request,z.object({name:z.string().trim().min(1).max(120),teamId:id.nullable().optional()}).strict());
      if(input.teamId) await member(runtime.db,input.teamId,user.id);
      await requireOrganization(runtime.db,user.id,input.teamId);
      const folder={id:uuid(),name:input.name,teamId:input.teamId||null};
      await runtime.db.query("INSERT INTO folders(id,name,owner_id,team_id) VALUES($1,$2,$3,$4)",[folder.id,folder.name,user.id,folder.teamId]);return json({folder});
    }
    if(path==="/api/videos"&&method==="GET") {
      const scope=url.searchParams.get("scope")||"home";const target=url.searchParams.get("id");
      if(scope==="team") {if(!target) throw new HttpError(400,"Choose a team");await member(runtime.db,target,user.id);}
      if(scope==="folder") await requireOrganization(runtime.db,user.id);
      const rows=await runtime.db.query(`SELECT v.*,u.name AS owner_name FROM videos v JOIN "user" u ON u.id=v.owner_id WHERE ${visible()}
        AND ($2<>'mine' OR v.owner_id=$1) AND ($2<>'team' OR v.team_id=$3) AND ($2<>'folder' OR v.folder_id=$3)
        ORDER BY v.created_at DESC,v.id DESC LIMIT 100`,[user.id,scope,target]);
      return json({videos:rows.rows.map(row=>videoJson(row,runtime))});
    }
    if(path==="/api/uploads"&&method==="POST") return json(await prepareUpload(runtime,user,await body(request,uploadSchema),request));
    let match=/^\/api\/uploads\/([^/]+)\/(bytes|complete)$/.exec(path);
    if(match) {
      if(match[2]==="bytes"&&method==="PUT") return json(await putUpload(runtime,user,match[1],request));
      if(match[2]==="complete"&&method==="POST") {await body(request,z.object({}).strict());return json(await completeUpload(runtime,user,match[1]));}
      throw new HttpError(405,"Method not allowed");
    }
    match=/^\/api\/videos\/([^/]+)\/share-link(?:\/(replace))?$/.exec(path);
    if(match) {
      if(method==="GET"&&!match[2]) return json({link:await readShareLink(runtime,match[1],user.id)});
      if(method!=="POST"&&!(method==="DELETE"&&!match[2])) throw new HttpError(405,"Method not allowed");
      await body(request,z.object({}).strict());
      if(method==="POST") return json({link:await shareLink(runtime,match[1],user.id,match[2]==="replace")});
      return json(await revokeShareLink(runtime,match[1],user.id));
    }
    match=/^\/api\/videos\/([^/]+)\/preview$/.exec(path);
    if(match) {
      if(method!=="GET"&&method!=="HEAD") throw new HttpError(405,"Method not allowed");
      return await servePreview(runtime,user,match[1],request);
    }
    match=/^\/api\/videos\/([^/]+)(?:\/(media|views|comments|process|feedback|slack|playback))?$/.exec(path);
    if(match) {
      const video=await accessibleVideo(runtime.db,match[1],user.id);const action=match[2];
      if(!action&&method==="DELETE") {
        if(video.owner_id!==user.id) throw new HttpError(403,"Only the video owner can delete this video");
        await body(request,z.object({}).strict());
        await transaction(runtime.db,async db=>{
          await accessibleVideo(db,video.id,user.id,true);
          await db.query("UPDATE videos SET deleted_at=now(),slack_generation=slack_generation+1 WHERE id=$1",[video.id]);
          await revokeVideoLink(db,video.id);
          await db.query("UPDATE jobs SET status='blocked',lease_until=NULL,error=CASE WHEN status='uncertain' THEN 'Video deleted; prior provider outcome remains uncertain' ELSE 'Video deleted by its owner' END,updated_at=now() WHERE video_id=$1 AND status<>'succeeded'",[video.id]);
        });
        return json({deleted:true});
      }
      if(!action&&method==="GET") {
        const [comments,words,slack,slackOperation,viewers]=await Promise.all([
          runtime.db.query("SELECT * FROM comments WHERE video_id=$1 ORDER BY (source='summary' AND parent_id IS NULL) DESC,created_at,id",[video.id]),
          runtime.db.query('SELECT word,start_ms AS "startMs",end_ms AS "endMs" FROM transcript_words WHERE video_id=$1 ORDER BY ordinal',[video.id]),
          runtime.db.query("SELECT st.thread_url,st.error FROM slack_threads st WHERE st.video_id=$1",[video.id]),
          runtime.db.query("SELECT status,error FROM jobs WHERE video_id=$1 AND kind LIKE 'slack_%' AND status IN ('blocked','uncertain','error') AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",[video.id]),
          runtime.db.query(`SELECT u.id,u.name,u.image,count(*) OVER ()::integer AS total FROM (
            SELECT viewer_id,max(day) AS day,max(viewed_at) AS viewed_at FROM views WHERE video_id=$1 GROUP BY viewer_id
          ) people JOIN "user" u ON u.id=people.viewer_id ORDER BY people.day DESC,people.viewed_at DESC NULLS LAST,u.id LIMIT 5`,[video.id])]);
        const connection=video.team_id?await runtime.db.query("SELECT status,error FROM slack_installations WHERE team_id=$1",[video.team_id]):null;
        const feedback=(await runtime.db.query("SELECT status,error FROM jobs WHERE operation_key=$1",[`feedback:${video.id}`])).rows[0];
        return json({video:videoJson(video,runtime),shareLink:video.owner_id===user.id?await readShareLink(runtime,video.id,user.id):null,comments:comments.rows.map(commentJson),words:words.rows,
          viewers:{items:viewers.rows.map(({id,name,image})=>({id,name,image})),total:viewers.rows[0]?.total||0},
          processing:{status:video.ai_status,error:video.processing_error},feedback:{status:feedback?.status || "pending",error:feedback?.error || null},slack:{connected:connection?.rows[0]?.status==="connected",threadUrl:slack.rows[0]?.thread_url||null,error:slack.rows[0]?.error||connection?.rows[0]?.error||slackOperation.rows[0]?.error||null}});
      }
      if(!action&&method==="PATCH") {
        if(video.owner_id!==user.id) throw new HttpError(403,"Only the video owner can change sharing");
        const input=await body(request,z.object({title:z.string().trim().min(1).max(240).optional(),teamId:id.nullable().optional(),folderId:id.nullable().optional()}).strict());
        await transaction(runtime.db,async db=>{
          const locked=await accessibleVideo(db,video.id,user.id,true);
          const teamId=input.teamId===undefined?locked.team_id:input.teamId;const folderId=input.folderId===undefined?locked.folder_id:input.folderId;
          if(input.teamId!==undefined||input.folderId!==undefined) await validateScope(db,user.id,teamId,folderId);
          if(teamId!==locked.team_id) {const linked=await db.query("SELECT 1 FROM slack_threads WHERE video_id=$1",[video.id]);if(linked.rowCount) throw new HttpError(409,"Disconnect the existing Slack thread before changing this video's team");}
          await db.query("UPDATE videos SET title=$2,team_id=$3,folder_id=$4 WHERE id=$1",[video.id,input.title??locked.title,teamId,folderId]);
          if(teamId&&teamId!==locked.team_id) await revokeVideoLink(db,video.id);
          if(input.title!==undefined) await db.query("DELETE FROM search_records WHERE id=$1",[`title:${video.id}`]);
          await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);});
        return json({video:videoJson(await accessibleVideo(runtime.db,video.id,user.id),runtime)});
      }
      if(action==="media"&&(method==="GET"||method==="HEAD")) {if(video.upload_state!=="uploaded") throw new HttpError(409,"Recording is still uploading");return await runtime.storage.read(video.storage_key,request,video.mime_type);}
      if(action==="playback"&&method==="GET") {
        if(url.searchParams.get("original")==="1"||video.processing_status!=="stream_ready") return json({mediaUrl:`/api/videos/${video.id}/media`,streamUrl:null});
        return json(await playbackJson(runtime,video.stream_uid,`/api/videos/${video.id}/media`));
      }
      if(action==="views"&&method==="POST") {
        const input=await body(request,z.object({eventId:z.string().min(1).max(120)}).strict());
        const recorded=await transaction(runtime.db,async db=>{const result=await db.query("INSERT INTO views(video_id,viewer_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING video_id",[video.id,user.id,input.eventId]);if(result.rowCount&&video.owner_id!==user.id) await recordEvent(db,video,user,"view",`view:${video.id}:${user.id}:${new Date().toISOString().slice(0,10)}`);return !!result.rowCount;});
        return json({recorded});
      }
      if(action==="comments"&&method==="POST") {
        const input=await body(request,z.object({body:z.string().trim().min(1).max(10_000),positionMs:position,parentId:id.nullable().optional()}).strict());
        const comment=await transaction(runtime.db,async db=>createComment(db,await accessibleVideo(db,video.id,user.id),{...input,authorId:user.id,authorName:user.name,source:"web"}));
        return json({comment:commentJson(comment)});
      }
      if(action==="process"&&method==="POST") {
        if(video.owner_id!==user.id) throw new HttpError(403,"Only the owner can retry processing");await body(request,z.object({}).strict());
        if(video.upload_state!=="uploaded") throw new HttpError(409,"Finish uploading first");
        await enqueue(runtime.db,"process",video.id,`process:${video.id}`);
        await runtime.db.query("UPDATE jobs SET status='pending',available_at=now(),error=NULL WHERE operation_key=$1 AND status IN ('blocked','succeeded','error')",[`process:${video.id}`]);
        return json({status:transcriptionProvider(runtime)?"queued":transcriptionSetup});
      }
      if(action==="feedback"&&method==="POST") {
        if(video.owner_id!==user.id) throw new HttpError(403,"Only the owner can request video feedback");
        await body(request,z.object({}).strict());
        await enqueue(runtime.db,"feedback",video.id,`feedback:${video.id}`);
        await runtime.db.query("UPDATE jobs SET status='pending',available_at=now(),error=NULL WHERE operation_key=$1 AND status IN ('blocked','error')",[`feedback:${video.id}`]);
        return json({queued:true});
      }
      if(action==="slack"&&method==="POST") {const input=await body(request,z.object({channelId:z.string().regex(/^[CG][A-Z0-9]+$/)}).strict());return json(await shareSlack(runtime,user,video,input.channelId));}
      if(action==="slack"&&method==="DELETE") {
        if(video.owner_id!==user.id) throw new HttpError(403,"Only the owner can disconnect the Slack thread");
        await transaction(runtime.db,async db=>{
          await db.query("UPDATE videos SET slack_generation=slack_generation+1 WHERE id=$1",[video.id]);
          await db.query("DELETE FROM slack_messages WHERE video_id=$1",[video.id]);
          await db.query("DELETE FROM slack_threads WHERE video_id=$1",[video.id]);
          await db.query("UPDATE jobs SET status='blocked',error='Thread disconnected by owner' WHERE video_id=$1 AND kind LIKE 'slack_%' AND status IN ('pending','retry','uncertain')",[video.id]);
        });return json({disconnected:true});
      }
    }
    match=/^\/api\/comments\/([^/]+)$/.exec(path);
    if(match&&["PATCH","DELETE"].includes(method)) {
      let commentId:string;
      try {commentId=id.parse(decodeURIComponent(match[1]!));}
      catch {throw new HttpError(400,"Invalid comment identifier");}
      const target=(await runtime.db.query("SELECT * FROM comments WHERE id=$1",[commentId])).rows[0];
      if(!target) throw new HttpError(404,"Comment not found");
      const video=await accessibleVideo(runtime.db,target.video_id,user.id);
      const removeAgent=target.source==="agent"&&method==="DELETE"&&video.owner_id===user.id;
      if(!removeAgent&&(target.author_id!==user.id||!["web","summary"].includes(target.source))) throw new HttpError(403,"Only the original author can change this comment. The video owner can remove agent feedback");
      const input=method==="PATCH"?await body(request,z.object({body:z.string().trim().min(1).max(10_000)}).strict()):null;
      await transaction(runtime.db,async db=>{
        const current=(await db.query("SELECT deleted_at FROM comments WHERE id=$1 FOR UPDATE",[target.id])).rows[0];
        if(current.deleted_at&&method==="PATCH") throw new HttpError(409,"Deleted comments cannot be edited");
        await db.query("UPDATE comments SET body=$2,deleted_at=$3,summary_managed=false,updated_at=now() WHERE id=$1",[target.id,input?.body||"",method==="DELETE"?new Date():null]);
        await db.query("DELETE FROM search_records WHERE id=$1",[`comment:${target.id}`]);
        await enqueue(db,"index",video.id,`index:${video.id}:${uuid()}`);
        await enqueue(db,"slack_comment",video.id,`slack:${method}:${target.id}:${uuid()}`,{commentId:target.id,action:method==="DELETE"?"delete":"update",actorId:user.id});
      });
      return json({saved:true});
    }
    if(path==="/api/search"&&method==="GET") {
      const q=z.string().trim().min(1).max(300).parse(url.searchParams.get("q")||"");
      return json(await searchWorkspace(runtime,user.id,q,{semantic:url.searchParams.get("semantic")==="1",signal:request.signal}));
    }
    if(path==="/api/search/answer"&&method==="POST") {
      const input=await body(request,z.object({query:z.string().trim().min(1).max(300)}).strict());
      return json(await answerWorkspace(runtime,user.id,input.query,request.signal));
    }
    if(path==="/api/slack/connect"&&method==="GET") return await slackConnect(request,runtime,user);
    if(path==="/api/slack/callback"&&method==="GET") return await slackCallback(request,runtime,user);
    throw new HttpError(404,"Endpoint not found");
  } catch(error) {
    if(error instanceof HttpError) {
      const response=json({error:error.message},error.status);
      if(error.status===401&&new URL(request.url).pathname==="/api/mcp") response.headers.set("WWW-Authenticate","Bearer");
      return response;
    }
    if(error instanceof ProviderError) return json({error:error.message,uncertain:error.uncertain},error.retryAfter?429:error.blocked?503:502);
    if(error instanceof z.ZodError) return json({error:error.issues.map(i=>i.message).join("; ")},400);
    console.error("API request failed",error instanceof Error?error.message:error);
    return json({error:"Request failed. Check the server log and retry"},500);
  }
}
