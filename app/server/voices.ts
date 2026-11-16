import { createHash } from "node:crypto";
import { z } from "zod";
import { recordingRetryNotice, voiceConsentVersion } from "../../shared/agent-templates";
import type { VoiceProfile, VoiceSetup } from "../../shared/agent-templates";
import type { User } from "../../shared/contracts";
import { body, json } from "./http";
import { HttpError, transaction, uuid } from "./runtime";
import type { Runtime } from "./runtime";

type VoiceRow = {id:string;owner_id:string;request_id:string;name:string;provider_voice_id:string|null;status:VoiceProfile["status"]|"deleted";consent_version:string;sample_sha256:string;revoked_at:Date|null;error:string|null;created_at:Date};
const providerId=z.string().min(1).max(200);
const cloneReceipt=z.object({voice_id:providerId,requires_verification:z.boolean()});
const voiceReceipt=z.object({voice_id:providerId,name:z.string().optional(),labels:z.record(z.string(),z.string()).optional(),voice_verification:z.object({requires_verification:z.boolean(),is_verified:z.boolean()}).nullable().optional()});
const sampleLimit=8*1024*1024;
function publicProfile(row:VoiceRow|null):VoiceProfile|null {
  if(!row||row.status==="deleted") return null;
  return {id:row.id,name:row.name,status:row.status,error:row.error,createdAt:new Date(row.created_at).toISOString()};
}
async function current(runtime:Runtime,ownerId:string):Promise<VoiceRow|null> {
  return (await runtime.db.query("SELECT * FROM voice_profiles WHERE owner_id=$1 AND status<>'deleted' ORDER BY created_at DESC LIMIT 1",[ownerId])).rows[0]||null;
}
function configured(runtime:Runtime) {
  if(!runtime.env.ELEVENLABS_API_KEY) throw new HttpError(503,"Ask your workspace operator to set a server-only ELEVENLABS_API_KEY with voice creation, voice read/delete, speech access, and a credit limit");
  return runtime.env.ELEVENLABS_API_KEY;
}
async function bytes(input:Request|Response,limit:number) {
  const reader=input.body?.getReader();const chunks:Uint8Array[]=[];let length=0;
  if(reader) try {for(;;) {const {done,value}=await reader.read();if(done) break;length+=value.byteLength;if(length>limit) {if(input instanceof Response) await reader.cancel();throw new HttpError(413,"Voice request or provider response exceeded its byte limit");}chunks.push(value);}} finally {reader.releaseLock();}
  const result=new Uint8Array(length);let offset=0;for(const chunk of chunks) {result.set(chunk,offset);offset+=chunk.length;}return result;
}
async function provider(runtime:Runtime,path:string,options:RequestInit={}) {
  const key=configured(runtime);
  try {return await fetch("https://api.elevenlabs.io"+path,{...options,redirect:"error",headers:{...Object.fromEntries(new Headers(options.headers)),"xi-api-key":key},signal:AbortSignal.timeout(120_000)});}
  catch {throw new HttpError(502,"ElevenLabs did not confirm the operation. Check your voice status before retrying");}
}
function providerFailure(status:number) {
  return new HttpError([401,403].includes(status)?503:502,`ElevenLabs returned ${status}. ${[401,403].includes(status)?"Ask your operator to check the API key scopes, voice-cloning entitlement, and provider verification.":status===429?"The provider rate or credit limit was reached. Retry after checking your provider quota.":"Check your provider account and voice verification before retrying."}`);
}
async function providerJson<T>(response:Response,schema:z.ZodType<T>):Promise<T> {
  const raw=await bytes(response,256*1024);
  try {return schema.parse(JSON.parse(new TextDecoder().decode(raw)));}
  catch {throw new HttpError(502,"ElevenLabs returned an invalid receipt. Check your voice status before retrying");}
}
export async function personalNarration(runtime:Runtime,userId:string) {
  configured(runtime);
  const profile=await current(runtime,userId);
  if(!profile||profile.status!=="ready"||profile.revoked_at||profile.consent_version!==voiceConsentVersion) throw new HttpError(409,"Create and verify your own consented voice in Demo agent Settings before choosing personal narration");
  return {profileId:profile.id,narration:{kind:"personal" as const,name:profile.name}};
}
export async function personalSpeech(runtime:Runtime,ownerId:string,profileId:string,text:string) {
  const row=(await runtime.db.query("SELECT * FROM voice_profiles WHERE id=$1 AND owner_id=$2 AND status='ready' AND revoked_at IS NULL AND consent_version=$3",[profileId,ownerId,voiceConsentVersion])).rows[0] as VoiceRow|undefined;
  if(!row?.provider_voice_id) throw new HttpError(409,"This run's personal voice is unavailable or revoked. Create a new run with your own verified voice or select default narration");
  const response=await provider(runtime,`/v1/text-to-speech/${encodeURIComponent(row.provider_voice_id)}?output_format=mp3_44100_128`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,model_id:"eleven_multilingual_v2"})});
  if(!response.ok) {await response.body?.cancel();throw providerFailure(response.status);}
  if(!response.headers.get("content-type")?.startsWith("audio/")) {await response.body?.cancel();throw new HttpError(502,`ElevenLabs did not return narration audio. ${recordingRetryNotice}`);}
  const audio=await bytes(response,32*1024*1024);
  if(!audio.byteLength) throw new HttpError(502,`ElevenLabs returned empty narration audio. ${recordingRetryNotice}`);
  const active=await runtime.db.query("SELECT 1 FROM voice_profiles WHERE id=$1 AND owner_id=$2 AND status='ready' AND revoked_at IS NULL",[row.id,ownerId]);
  if(!active.rowCount) throw new HttpError(409,"Voice consent changed during speech generation. The generated audio was discarded");
  return new Response(audio,{headers:{"Content-Type":response.headers.get("content-type")!,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}

export async function voiceApi(request:Request,runtime:Runtime,user:User):Promise<Response|null> {
  const path=new URL(request.url).pathname;
  if(path!=="/api/agents/voice"&&path!=="/api/agents/voice/check") return null;
  if(path.endsWith("/check")&&request.method==="POST") {
    await body(request,z.object({}).strict());
    const row=await current(runtime,user.id);
    if(!row?.provider_voice_id||row.revoked_at||row.status!=="verification_required") throw new HttpError(409,"Only your own voice awaiting provider verification can be checked");
    const response=await provider(runtime,`/v1/voices/${encodeURIComponent(row.provider_voice_id)}`);
    if(!response.ok) {await response.body?.cancel();throw providerFailure(response.status);}
    const receipt=await providerJson(response,voiceReceipt);
    if(receipt.voice_id!==row.provider_voice_id) throw new HttpError(502,"ElevenLabs returned a different voice identity");
    if(receipt.voice_verification&&(receipt.voice_verification.is_verified||!receipt.voice_verification.requires_verification)) await runtime.db.query("UPDATE voice_profiles SET status='ready',error=NULL,updated_at=now() WHERE id=$1 AND status='verification_required' AND revoked_at IS NULL",[row.id]);
    return json({profile:publicProfile(await current(runtime,user.id)),configured:!!runtime.env.ELEVENLABS_API_KEY} satisfies VoiceSetup);
  }
  if(path.endsWith("/check")) throw new HttpError(405,"Use POST to check voice verification");
  if(request.method==="GET") return json({profile:publicProfile(await current(runtime,user.id)),configured:!!runtime.env.ELEVENLABS_API_KEY} satisfies VoiceSetup);
  if(request.method==="POST") {
    if(!request.headers.get("content-type")?.startsWith("multipart/form-data")) throw new HttpError(400,"Upload your own MP3 or WAV sample using the voice form");
    const data=await bytes(request,sampleLimit+64*1024);
    let form:FormData;
    try {form=await new Response(data,{headers:{"Content-Type":request.headers.get("content-type")!}}).formData();}
    catch {throw new HttpError(400,"The voice upload is not a valid multipart form");}
    const fields=["requestId","consentVersion","consent","sample"];
    if([...form.keys()].some(key=>!fields.includes(key)||form.getAll(key).length!==1)) throw new HttpError(400,"Send one own-voice sample and the consent fields only");
    const consent=z.object({requestId:z.uuid(),consentVersion:z.literal(voiceConsentVersion),consent:z.literal("yes")}).safeParse({requestId:form.get("requestId"),consentVersion:form.get("consentVersion"),consent:form.get("consent")});
    if(!consent.success) throw new HttpError(400,"Confirm that you are the speaker and consent to cloning your own voice");
    const sample=form.get("sample");
    if(!sample||typeof sample==="string"||sample.size===0||sample.size>sampleLimit||!["audio/mpeg","audio/mp3","audio/wav","audio/x-wav"].includes(sample.type)) throw new HttpError(400,"Choose one nonempty MP3 or WAV sample up to 8 MiB");
    const sampleBytes=new Uint8Array(await sample.arrayBuffer());
    const magic=new TextDecoder().decode(sampleBytes.slice(0,12));
    if(!(magic.startsWith("RIFF")&&magic.slice(8)==="WAVE")&&!magic.startsWith("ID3")&&!(sampleBytes[0]===255&&(sampleBytes[1]&224)===224)) throw new HttpError(400,"The sample bytes do not match an MP3 or WAV recording");
    const digest=createHash("sha256").update(sampleBytes).digest("hex");
    const reserved=await transaction(runtime.db,async db=>{
      await db.query('SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE',[user.id]);
      const prior=(await db.query<VoiceRow>("SELECT * FROM voice_profiles WHERE owner_id=$1 AND request_id=$2",[user.id,consent.data.requestId])).rows[0];
      if(prior) {
        if(prior.sample_sha256!==digest) throw new HttpError(409,"This request ID was already used for a different sample");
        return {row:prior,created:false};
      }
      configured(runtime);
      const name=user.name.trim().slice(0,200);
      if(!name) throw new HttpError(400,"Set a nonempty account name before creating your narration voice");
      const owner=await db.query("SELECT team_id FROM memberships WHERE user_id=$1 AND role='owner' ORDER BY team_id LIMIT 1 FOR SHARE",[user.id]);
      if(!owner.rowCount) throw new HttpError(403,"Create a team from the sidebar or ask your operator for team-owner access before creating a narration voice");
      const recent=await db.query<{created_at:Date}>("SELECT created_at FROM voice_profiles WHERE owner_id=$1 AND created_at>clock_timestamp()-interval '720 hours' ORDER BY created_at DESC LIMIT 3",[user.id]);
      if(recent.rows.length===3) throw new HttpError(429,`Voice creation is limited to 3 attempts per 30 days, including deleted and failed clones. Try again after ${new Date(new Date(recent.rows[2].created_at).getTime()+30*86_400_000).toISOString()}`);
      const active=await db.query("SELECT 1 FROM voice_profiles WHERE owner_id=$1 AND status<>'deleted'",[user.id]);
      if(active.rowCount) throw new HttpError(409,"Delete your current voice before creating another one");
      const inserted=await db.query<VoiceRow>("INSERT INTO voice_profiles(id,owner_id,request_id,name,status,consent_version,consented_at,sample_sha256) VALUES($1,$2,$3,$4,'creating',$5,now(),$6) RETURNING *",[uuid(),user.id,consent.data.requestId,name,voiceConsentVersion,digest]);
      return {row:inserted.rows[0],created:true};
    });
    if(!reserved.created) return json({profile:publicProfile(reserved.row),configured:!!runtime.env.ELEVENLABS_API_KEY});
    const row=reserved.row;
    let rejected=false;
    try {
      const upload=new FormData();upload.set("name",`Video Workspace ${row.id}`);upload.set("labels",JSON.stringify({workspace_profile:row.id}));upload.set("files",new Blob([sampleBytes],{type:sample.type}),sample.type.includes("wav")?"own-voice.wav":"own-voice.mp3");
      const response=await provider(runtime,"/v1/voices/add",{method:"POST",body:upload});
      if(!response.ok) {rejected=response.status>=400&&response.status<500;await response.body?.cancel();throw providerFailure(response.status);}
      const receipt=await providerJson(response,cloneReceipt);
      const saved=(await runtime.db.query("UPDATE voice_profiles SET provider_voice_id=$2,status=CASE WHEN revoked_at IS NULL THEN $3 ELSE 'delete_failed' END,error=CASE WHEN revoked_at IS NULL THEN $4 ELSE 'Voice creation finished after revocation. Retry Delete voice to remove it from ElevenLabs.' END,updated_at=now() WHERE id=$1 AND status<>'deleted' RETURNING *",[row.id,receipt.voice_id,receipt.requires_verification?"verification_required":"ready",receipt.requires_verification?"Ask your workspace operator to arrange ElevenLabs speaker verification with you, then check verification here.":null])).rows[0] as VoiceRow|undefined;
      return json({profile:publicProfile(saved||null),configured:true},201);
    } catch(error) {
      const message=error instanceof HttpError?error.message:"ElevenLabs did not confirm voice creation. Check your voice status before retrying";
      await runtime.db.query("UPDATE voice_profiles SET status=CASE WHEN $2='failed' THEN 'failed' WHEN revoked_at IS NOT NULL THEN 'delete_failed' ELSE $2 END,error=$3,updated_at=now() WHERE id=$1 AND provider_voice_id IS NULL AND status<>'deleted'",[row.id,rejected?"failed":"uncertain",message]);
      throw error instanceof HttpError?error:new HttpError(502,message);
    }
  }
  if(request.method==="DELETE") {
    await body(request,z.object({}).strict());
    const row=await current(runtime,user.id);
    if(!row) return json({profile:null,configured:!!runtime.env.ELEVENLABS_API_KEY} satisfies VoiceSetup);
    await runtime.db.query("UPDATE voice_profiles SET revoked_at=COALESCE(revoked_at,now()),status='deleting',updated_at=now() WHERE id=$1",[row.id]);
    try {
      let voiceId=row.provider_voice_id;
      if(!voiceId&&row.status!=="failed") {
        const response=await provider(runtime,`/v2/voices?search=${encodeURIComponent(row.id)}&page_size=100`);
        if(!response.ok) {await response.body?.cancel();throw providerFailure(response.status);}
        const receipt=await providerJson(response,z.object({voices:z.array(voiceReceipt).max(100),has_more:z.boolean()}));
        const matches=receipt.voices.filter(voice=>voice.labels?.workspace_profile===row.id||voice.name===`Video Workspace ${row.id}`);
        if(receipt.has_more||matches.length!==1) throw new HttpError(502,`Voice use is revoked locally. ElevenLabs could not confirm one matching clone. Check Voices for Video Workspace ${row.id}, then retry deletion. Do not create another clone yet`);
        voiceId=matches[0].voice_id;
        await runtime.db.query("UPDATE voice_profiles SET provider_voice_id=$2 WHERE id=$1",[row.id,voiceId]);
      }
      if(voiceId) {
        const response=await provider(runtime,`/v1/voices/${encodeURIComponent(voiceId)}`,{method:"DELETE"});
        if(response.status!==404) {
          if(!response.ok) {await response.body?.cancel();throw providerFailure(response.status);}
          await providerJson(response,z.object({status:z.literal("ok")}));
        } else await response.body?.cancel();
      }
      await runtime.db.query("UPDATE voice_profiles SET status='deleted',provider_voice_id=NULL,error=NULL,updated_at=now() WHERE id=$1",[row.id]);
    } catch(error) {
      const message=error instanceof HttpError?error.message:"ElevenLabs did not confirm remote deletion. Voice use is revoked locally. Retry Delete voice to confirm removal";
      await runtime.db.query("UPDATE voice_profiles SET status='delete_failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'deleted'",[row.id,message]);
    }
    return json({profile:publicProfile(await current(runtime,user.id)),configured:!!runtime.env.ELEVENLABS_API_KEY} satisfies VoiceSetup);
  }
  throw new HttpError(405,"Use GET, POST, or DELETE for your own voice profile");
}
