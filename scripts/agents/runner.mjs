import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { demoManifestSchema, demoResultSchema, demoPresentationSchema } from '../../shared/agent-schema.ts';
import { recordDemo } from './record.mjs';

const configured=new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:4783');
assert(configured.protocol==='https:' || configured.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(configured.hostname),'Use HTTPS or a loopback development server');
assert(!configured.username&&!configured.password&&!configured.search&&!configured.hash&&configured.pathname==='/','APP_ORIGIN must be an origin without credentials or a path');
const origin=configured.origin;
const token=process.env.DEMO_RUNNER_TOKEN;
assert(token&&token.length>=32,'Set the same separate DEMO_RUNNER_TOKEN on the control plane and trusted runner');
const storage=path.resolve(process.env.DEMO_OUTPUT_ROOT || '.local/agent-runs');
let stopped=false;
process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
function headers(claim,extra={}) {return {Authorization:`Bearer ${token}`,...(claim?{'X-Agent-Claim':claim}:{}),...extra};}
async function responseText(result,limit=4*1024*1024) {
  assert(result.body,'Runner response was empty');
  const reader=result.body.getReader();const chunks=[];let size=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done) break;size+=value.byteLength;assert(size<=limit,'Runner response exceeded its metadata byte budget');chunks.push(value);}
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
}
async function response(endpoint,method='GET',data,claim,signal) {
  const url=new URL(endpoint,origin);assert.equal(url.origin,origin);assert(url.pathname.startsWith('/api/agents/runner/'));
  const result=await fetch(url,{method,redirect:'error',headers:headers(claim,data===undefined?{}:{'Content-Type':'application/json'}),...(data===undefined?{}:{body:JSON.stringify(data)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180_000)]):AbortSignal.timeout(180_000)});
  if(!result.ok) {const raw=await responseText(result,65_536).catch(()=>'');let error;try {error=JSON.parse(raw).error;} catch {}throw Object.assign(new Error(`Runner operation returned ${result.status}. ${String(error || 'Check the control-plane status').slice(0,1000)}`),{status:result.status,operation:endpoint});}
  return result;
}
async function api(endpoint,method='GET',data,claim,signal) {return JSON.parse(await responseText(await response(endpoint,method,data,claim,signal),endpoint.endsWith('/status')?9*1024*1024:4*1024*1024));}
async function regular(file,max) {const info=await lstat(file);assert(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=max,'Retained runner artifact must be a bounded regular file');return info;}
async function hashFile(file) {const hash=createHash('sha256');for await(const bytes of createReadStream(file)) hash.update(bytes);return hash.digest('hex');}
async function saveStream(body,file,limit) {
  const temporary=file+'.partial';
  const descriptor=await open(temporary,'wx',0o600);let size=0;
  try {for await(const chunk of body) {size+=chunk.length;assert(size<=limit,'Downloaded runner input exceeded its byte budget');await descriptor.writeFile(chunk);}}
  finally {await descriptor.close();}
  assert(size>0,'Runner input was empty');await rename(temporary,file);return size;
}
const claimIdentity=z.object({id:z.uuid(),claim:z.string().min(64).max(256)});
const claimSchema=z.object({run:z.object({id:z.uuid(),recordingId:z.uuid(),audience:z.enum(['internal','customer']),title:z.string().min(1).max(240),presentation:demoPresentationSchema.optional(),retainedVideoId:z.uuid().nullable(),evidence:z.object({chapters:z.array(z.object({connectionId:z.string().min(1).max(100),repository:z.string().max(200),commitSha:z.string().regex(/^[a-f0-9]{40}$/),state:z.enum(['released','in_progress']),heading:z.string().max(500),facts:z.array(z.string().max(1000)).max(100),manifest:demoManifestSchema,sourceUrl:z.string().max(2048).optional()})).min(1).max(20),facts:z.array(z.string().max(1000)).max(200),limitations:z.array(z.string().max(2000)).max(200)})}).nullable(),claim:z.string().min(64).max(256).optional()});
async function pruneIntermediates(directory,captured) {
  const recording=path.dirname(captured.video);
  assert(recording===directory||recording.startsWith(directory+path.sep),'Recorder cleanup must remain inside this run');
  for(const name of await readdir(recording)) {
    const chapter=/^chapter-(\d+)$/.exec(name);
    if(chapter&&captured.result.chapters[Number(chapter[1])]?.status==='failed') continue;
    if(/^(?:chapter-\d+|speech-\d+|tool-input|concat\.txt|segment-\d+\.mp4)$/.test(name)) await rm(path.join(recording,name),{recursive:true,force:true});
  }
}

async function once() {
  const reply=await response('/api/agents/runner/claim','POST',{});
  const identity=claimIdentity.safeParse({id:reply.headers.get('x-agent-run-id'),claim:reply.headers.get('x-agent-claim')});
  let claimed;
  try {
    claimed=claimSchema.parse(JSON.parse(await responseText(reply)));
    if(identity.success) {assert.equal(claimed.run?.id,identity.data.id);assert.equal(claimed.claim,identity.data.claim);}
    if(claimed.run) assert(claimed.claim,'A claimed run needs its scoped lease');
  } catch(error) {
    if(identity.success) {
      await api(`/api/agents/runner/${identity.data.id}/failed`,'POST',{error:error.message.slice(0,1000)},identity.data.claim).catch(()=>{});
      const directory=path.join(storage,identity.data.id);await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(path.join(directory,'failure.json'),JSON.stringify({runId:identity.data.id,error:error.message.slice(0,2000)},null,2),{mode:0o600});
    }
    throw error;
  }
  if(!claimed.run) return false;
  assert(claimed.claim,'A claimed run needs its scoped lease');
  const run=claimed.run;const claim=claimed.claim;
  const directory=path.join(storage,run.id);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  const retainedPath=path.join(directory,'retained.json');
  let captured;let sources;
  const lease=new AbortController();let renewing=false;let leaseError;
  const heartbeat=setInterval(()=>{if(renewing||lease.signal.aborted) return;renewing=true;void api(`/api/agents/runner/${run.id}/heartbeat`,'POST',{},claim,lease.signal).catch(error=>{if(!lease.signal.aborted){leaseError=error;lease.abort(error);}}).finally(()=>{renewing=false;});},30_000);
  try {
    try {
      await regular(retainedPath,1_048_576);
      const retained=JSON.parse(await readFile(retainedPath,'utf8'));
      const video=path.resolve(directory,z.string().parse(retained.relativeVideo));
      assert(video.startsWith(directory+path.sep),'Retained media must remain inside this run directory');
      const info=await regular(video,4_900_000_000);
      assert.equal(info.size,retained.byteLength);assert.equal(await hashFile(video),retained.sha256);
      captured={video,sha256:retained.sha256,byteLength:info.size,durationMs:retained.durationMs,result:demoResultSchema.parse(retained.result)};
    } catch(error) {if(error.code!=='ENOENT') throw error;}
    if(!captured) {
      if(run.retainedVideoId) throw new Error('Restore this run’s retained original from the previous recorder before retrying. A different recording cannot replace the prepared UUID');
      sources=path.join(directory,`source-${Date.now()}`);await mkdir(sources,{mode:0o700});
      const chapters=[];
      for(let index=0;index<run.evidence.chapters.length;index++) {
        const chapter=run.evidence.chapters[index];
        const archive=await response(`/api/agents/runner/${run.id}/source?chapter=${index}`,'GET',undefined,claim);
        assert.equal(archive.headers.get('x-source-commit'),chapter.commitSha,'Source receipt must match the exact queued commit');
        const target=path.join(sources,`${index}.tar.gz`);
        await saveStream(archive.body,target,128*1024*1024);
        chapters.push({...chapter,archive:target});
      }
      const output=path.join(directory,`recording-${Date.now()}`);
      captured=await recordDemo({id:run.id,audience:run.audience,title:run.title,presentation:run.presentation,facts:run.evidence.facts,chapters},output,{
        signal:lease.signal,
        plan:(chapter,dom)=>api(`/api/agents/runner/${run.id}/plan`,'POST',{chapter,dom},claim),
        speech:async(text,destination)=>{
          const audio=await response(`/api/agents/runner/${run.id}/speech`,'POST',{text},claim);
          if(!audio.headers.get('content-type')?.startsWith('audio/')) {const fallback=JSON.parse(await responseText(audio));assert.equal(fallback.local,true);return null;}
          const file=path.join(destination,audio.headers.get('content-type').includes('wav')?'narration.wav':'narration.mp3');await saveStream(audio.body,file,128*1024*1024);await chmod(file,0o644);return file;
        },
      });
      await writeFile(retainedPath+'.tmp',JSON.stringify({...captured,video:undefined,relativeVideo:path.relative(directory,captured.video)},null,2),{mode:0o600});await rename(retainedPath+'.tmp',retainedPath);
    }
    if(leaseError) throw leaseError;
    const prepared=await api(`/api/agents/runner/${run.id}/upload`,'POST',{byteLength:captured.byteLength,durationMs:captured.durationMs,sha256:captured.sha256,result:captured.result},claim);
    assert.equal(prepared.video.recordingId,run.recordingId,'Prepared upload must keep the run recording UUID');
    z.uuid().parse(prepared.video.id);if(run.retainedVideoId) assert.equal(prepared.video.id,run.retainedVideoId,'Prepared upload must keep its existing video identity');
    if(prepared.video.uploadState!=='uploaded') {
      const upload=new URL(z.string().parse(prepared.upload.url));
      assert(upload.protocol==='https:' || upload.origin===origin,'Object uploads need HTTPS or the configured loopback server');
      const local=upload.origin===origin;
      if(local) assert.equal(upload.pathname,`/api/agents/runner/${run.id}/bytes`);
      const result=await fetch(upload,{method:'PUT',redirect:'error',headers:{...prepared.upload.headers,'Content-Length':String(captured.byteLength),...(local?headers(claim):{})},body:Readable.toWeb(createReadStream(captured.video)),duplex:'half',signal:AbortSignal.timeout(30*60_000)});
      await result.body?.cancel();
      assert(result.ok,`Media upload returned ${result.status}. The original remains available for retry`);
    }
    const completed=await api(`/api/agents/runner/${run.id}/complete`,'POST',{},claim);
    assert.equal(completed.receipt.durable,true);assert.equal(completed.receipt.recordingId,run.recordingId);assert.equal(completed.receipt.byteLength,captured.byteLength);
    if(completed.receipt.sha256) assert.equal(completed.receipt.sha256,captured.sha256);
    assert.equal(completed.video.id,prepared.video.id,'Completed upload must keep its prepared video identity');
    await writeFile(path.join(directory,'receipt.json'),JSON.stringify({runId:run.id,videoId:completed.video.id,receipt:completed.receipt,artifactSha256:captured.sha256},null,2),{mode:0o600});
    await pruneIntermediates(directory,captured);
    console.log(JSON.stringify({runId:run.id,status:'uploaded',videoId:completed.video.id}));
  } catch(error) {
    let recovered=false;
    try {
      const status=await api(`/api/agents/runner/${run.id}/status`);
      if(status.run.status==='uploaded'&&status.receipt?.durable&&status.receipt.recordingId===run.recordingId&&captured&&status.receipt.byteLength===captured.byteLength&&(!status.receipt.sha256||status.receipt.sha256===captured.sha256)&&(!run.retainedVideoId||status.run.videoId===run.retainedVideoId)) {
        await writeFile(path.join(directory,'receipt.json'),JSON.stringify({runId:run.id,videoId:status.run.videoId,receipt:status.receipt,artifactSha256:captured.sha256,recovered:true},null,2),{mode:0o600});
        console.log(JSON.stringify({runId:run.id,status:'uploaded',recovered:true}));recovered=true;await pruneIntermediates(directory,captured);
      }
      if(!recovered&&[400,422].includes(error.status)&&error.operation===`/api/agents/runner/${run.id}/upload`&&!run.retainedVideoId&&status.run.id===run.id&&status.run.videoId===null&&status.run.result===null) await rename(retainedPath,path.join(directory,`retained-rejected-${Date.now()}.json`));
    } catch {}
    if(!recovered) {
      await writeFile(path.join(directory,'failure.json'),JSON.stringify({runId:run.id,error:error.message.slice(0,2000)},null,2),{mode:0o600});
      await api(`/api/agents/runner/${run.id}/failed`,'POST',{error:error.message.slice(0,1000)},claim).catch(()=>{});
      console.error(JSON.stringify({runId:run.id,status:'failed',error:error.message.slice(0,1000)}));
      if(process.argv.includes('--once')) process.exitCode=1;
    }
  } finally {clearInterval(heartbeat);lease.abort();if(sources) await rm(sources,{recursive:true,force:true});}
  return true;
}

do {
  try {const active=await once();if(process.argv.includes('--once')) break;if(!active) await new Promise(resolve=>setTimeout(resolve,5000));}
  catch(error) {console.error(error.message.slice(0,1000));if(process.argv.includes('--once')) {process.exitCode=1;break;}await new Promise(resolve=>setTimeout(resolve,5000));}
} while(!stopped);
