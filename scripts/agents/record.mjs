import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { demoActionSchema, demoManifestSchema, demoResultSchema, demoPresentationSchema } from '../../shared/agent-schema.ts';
import { agentTemplates, recordingRetryNotice } from '../../shared/agent-templates.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const directory=path.join(root,'scripts/agents');
const inputSchema=z.object({id:z.string().min(1).max(100),audience:z.enum(['internal','customer']),title:z.string().min(1).max(240),presentation:demoPresentationSchema.optional(),mode:z.enum(['ai','scripted']).optional(),facts:z.array(z.string().max(1000)).max(200).optional(),chapters:z.array(z.object({connectionId:z.string().min(1).max(100),repository:z.string().max(200),commitSha:z.string().regex(/^[a-f0-9]{40}$/),state:z.enum(['released','in_progress']),heading:z.string().max(500),facts:z.array(z.string().max(1000)).max(100),archive:z.string().min(1),manifest:demoManifestSchema,sourceUrl:z.string().optional(),changes:z.array(z.object({path:z.string(),patch:z.string()})).optional()}).strict()).min(1).max(20)}).strict();
async function command(args,{input,timeout=120_000,allowFailure=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
    let stdout='';let stderr='';let expired=false;
    child.stdout.on('data',bytes=>{stdout=(stdout+bytes).slice(-65_536);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-65_536);});
    child.stdin.on('error',error=>{if(error.code!=='EPIPE') reject(error);});
    const timer=setTimeout(()=>{expired=true;child.kill('SIGTERM');},timeout);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if ((code===0&&!expired)||allowFailure) resolve({code,stdout,stderr});else {const lines=stderr.trim().split('\n');const cause=lines.find(line=>line.startsWith('RuntimeError:')) || lines.find(line=>line.startsWith('npm error')) || lines.find(line=>line.startsWith('Error:')) || lines.at(-1) || stdout.slice(-1000);reject(Object.assign(new Error(expired?'Isolated command exceeded its runtime limit':`Isolated command failed (${code}): ${cause.slice(0,1500)}`),{stdout,stderr,exitCode:code}));}});
    if(input!==undefined) child.stdin.end(input);else child.stdin.end();
  });
}
async function regular(file,max=1_048_576) {
  const info=await lstat(file);
  assert(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=max,'Recorder artifact is not a bounded regular file');
  return info;
}
async function json(file,max) {await regular(file,max);return JSON.parse(await readFile(file,'utf8'));}
async function hashFile(file) {const hash=createHash('sha256');for await(const bytes of createReadStream(file)) hash.update(bytes);return hash.digest('hex');}
async function image() {
  const hash=createHash('sha256');
  for (const file of ['Dockerfile','capture.mjs','container.mjs']) hash.update(await readFile(path.join(directory,file)));
  const tag=`video-workspace-demo:${hash.digest('hex').slice(0,16)}`;
  const found=await command(['image','inspect',tag],{allowFailure:true});
  if(found.code!==0) await command(['build','--tag',tag,'--file',path.join(directory,'Dockerfile'),directory],{timeout:15*60_000});
  const receipt=await command(['image','inspect','--format','{{.Id}}',tag]);
  return {tag,id:receipt.stdout.trim()};
}

export async function recordDemo(raw,output,providers={}) {
  const input=inputSchema.parse(raw);
  const settings=input.presentation||{template:input.audience==='customer'?'customer_release':'weekly_team',recipient:'',brief:'',narration:{kind:'default'}};
  assert(settings.narration.kind!=='personal'||providers.speech,'Personal narration needs the authenticated control-plane speech adapter');
  assert(input.audience!=='customer'||input.chapters.every(chapter=>chapter.state==='released'),'Customer drafts cannot include in-progress source snapshots');
  const resolved=path.resolve(output);
  await mkdir(path.dirname(resolved),{recursive:true,mode:0o700});
  await mkdir(resolved,{mode:0o700});
  await chmod(resolved,0o777);
  const instance=randomUUID().replaceAll('-','').slice(0,16);
  const network=`video-demo-${instance}`;
  const containers=new Set();
  let stopping=false;
  let completed=false;
  const report={image:null,archives:[],containers:[],limitations:['Package fetch uses registry access with lifecycle scripts disabled. Repository builds and runtime have no network beyond the browser sharing isolated loopback.', 'Each chapter has a 512 MiB ephemeral source/build filesystem and a 128 MiB per-file limit within its 1 GiB application memory limit.', 'Video feedback uses sampled frames. Scripted narration describes measured actions and source headlines.']};
  const result={status:'succeeded',mode:'scripted',narration:'',...(input.presentation?{presentation:settings}:{}),chapters:[]};
  const clips=[];
  async function cleanup() {
    for(const name of containers) await command(['rm','--force',name],{allowFailure:true}).catch(()=>{});
    containers.clear();
    if(!completed) {
      for(let index=0;index<input.chapters.length;index++) {await rm(path.join(resolved,`speech-${index}`),{recursive:true,force:true});await rm(path.join(resolved,`segment-${index}.mp4`),{force:true});}
      await rm(path.join(resolved,'concat.txt'),{force:true});
    }
  }
  async function stop() {if(stopping) return;stopping=true;await cleanup();process.exit(130);}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const abort=()=>{void cleanup();};providers.signal?.addEventListener('abort',abort,{once:true});
  function runArgs(name,dir,kind='tool') {
    providers.signal?.throwIfAborted();
    containers.add(name);report.containers.push(name);
    return ['run','--rm','--init','--name',name,'--label',`video-workspace.agent-run=${instance}`,'--user','1000:1000','--cap-drop','ALL',...(kind==='browser'?['--cap-add','SYS_CHROOT','--security-opt',`seccomp=${path.join(directory,'seccomp_profile.json')}`]:[]),'--security-opt','no-new-privileges','--read-only','--pids-limit',kind==='app'?'128':'256','--cpus','1','--memory',kind==='app'?'1024m':'1536m','--shm-size','256m','--tmpfs',`/tmp:rw,nosuid,nodev,size=${kind==='app'?'384m':'768m'}`,...(kind==='app'?['--tmpfs','/app:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700','--ulimit','fsize=134217728:134217728']:[]),'--log-opt','max-size=2m','--log-opt','max-file=1','--mount',`type=bind,src=${dir},dst=/input,readonly`];
  }
  try {
    const built=await image();report.image=built.id;
    const toolInput=path.join(resolved,'tool-input');await mkdir(toolInput);
    let allAI=true;let opened=false;
    for(let index=0;index<input.chapters.length;index++) {
      const chapter=input.chapters[index];
      const section=path.join(resolved,`chapter-${index}`);const safeInput=path.join(section,'input');const out=path.join(section,'output');
      await mkdir(safeInput,{recursive:true});await mkdir(out,{mode:0o777});await chmod(out,0o777);
      await regular(chapter.archive,128*1024*1024);await cp(chapter.archive,path.join(safeInput,'source.tar.gz'));
      await writeFile(path.join(safeInput,'chapter.json'),JSON.stringify({commitSha:chapter.commitSha,manifest:chapter.manifest}));
      report.archives.push({repository:chapter.repository,commitSha:chapter.commitSha,sha256:await hashFile(chapter.archive)});
      const appName=`${network}-app-${index}`;
      const target=`http://127.0.0.1:${chapter.manifest.port}`;
      let preview;let error;
      try {
        await command([...runArgs(appName,safeInput,'app'),'--detach','--network',chapter.manifest.install?'bridge':'none',built.tag,'node','-e','setInterval(()=>{},60000)']);
        await command(['exec',appName,'node','/opt/demo/container.mjs','setup'],{timeout:5*60_000});
        if(chapter.manifest.install) await command(['network','disconnect','bridge',appName]);
        if(chapter.manifest.install||chapter.manifest.build) await command(['exec',appName,'node','/opt/demo/container.mjs','build'],{timeout:8*60_000});
        await command(['exec','--detach',appName,'node','/opt/demo/container.mjs','start']);
        for(let attempt=0;attempt<40;attempt++) {
          const health=await command(['exec',appName,'node','-e',`fetch('http://127.0.0.1:${chapter.manifest.port}',{signal:AbortSignal.timeout(1000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],{allowFailure:true,timeout:2500});
          if(health.code===0) break;
          if(attempt===39) throw new Error('Application did not start inside the isolated runtime');
          await new Promise(resolve=>setTimeout(resolve,500));
        }
        await writeFile(path.join(safeInput,'capture.json'),JSON.stringify({url:target}));
        await command([...runArgs(`${network}-preview-${index}`,safeInput,'browser'),'--network',`container:${appName}`,'--mount',`type=bind,src=${out},dst=/out`,built.tag,'node','/opt/demo/capture.mjs','preview'],{timeout:60_000});
        preview=await json(path.join(out,'preview.json'),100_000);
      } catch(failure) {error=failure.message.slice(0,1500);await writeFile(path.join(section,'setup-log.json'),JSON.stringify({error,stdout:failure.stdout,stderr:failure.stderr,exitCode:failure.exitCode},null,2));}
      let plan={actions:chapter.manifest.actions || [],mode:'scripted'};
      try {
        if(!error&&providers.plan) plan=await providers.plan(index,z.string().min(1).max(24_000).parse(preview.dom));
        plan=z.object({actions:z.array(demoActionSchema).max(20),mode:z.enum(['ai','scripted'])}).parse({actions:plan.actions,mode:plan.mode});
        if(!error&&!plan.actions.length) throw new Error('Configure Workers AI planning or provide bounded demo actions in the checked-in manifest');
      } catch(failure) {error=failure.message.trim().slice(0,1500)||'The demo planner could not produce a valid recording plan';plan={actions:[],mode:'scripted'};}
      allAI=allAI&&plan.mode==='ai';
      const label=input.audience==='customer'?'CUSTOMER RELEASE DRAFT':chapter.state==='released'?'INTERNAL · RELEASED':'INTERNAL · IN PROGRESS';
      const cards=[];
      if(!opened) {
        cards.push({title:agentTemplates[settings.template].label,lines:[settings.recipient?`Recorded for ${settings.recipient}`:agentTemplates[settings.template].description,settings.narration.kind==='personal'?`AI narration using ${settings.narration.name}'s consented voice.`:'Synthetic narration.',...(settings.brief?['Includes owner-provided context. Source checks appear in the recording.']:[])],label:input.audience==='customer'?'PRIVATE DRAFT · REVIEW BEFORE SHARING':'RECORDED AGENT WORK'});
        const facts=input.facts?.length?input.facts:input.chapters.flatMap(item=>item.facts);
        for(let offset=0;offset<facts.length;offset+=4) cards.push({title:offset===0?input.title:'This week',lines:facts.slice(offset,offset+4),label:input.audience==='customer'?'PRIVATE DRAFT · REVIEW BEFORE SHARING':'TEAM ROUNDUP'});
      }
      cards.push({title:chapter.heading,lines:chapter.facts.slice(0,4),label});
      if(error) cards.push({title:'This demo could not start',lines:input.audience==='internal'?[error]:['This scene needs review before sharing.'],label});
      await writeFile(path.join(safeInput,'capture.json'),JSON.stringify({url:error?null:target,actions:plan.actions,mode:plan.mode,audience:input.audience,cards,failure:error}));
      await command([...runArgs(`${network}-record-${index}`,safeInput,'browser'),'--network',error?'none':`container:${appName}`,'--mount',`type=bind,src=${out},dst=/out`,built.tag,'node','/opt/demo/capture.mjs'],{timeout:5*60_000});
      await command(['rm','--force',appName],{allowFailure:true});containers.delete(appName);
      const captured=await json(path.join(out,'capture-result.json'),100_000);
      const video=z.string().regex(/^\/out\/video\/[a-zA-Z0-9@_-]+\.webm$/).parse(captured.video);
      const media=path.join(out,'video',path.basename(video));await regular(media,512*1024*1024);
      const actions=z.array(z.object({kind:z.string(),status:z.enum(['succeeded','failed']),positionMs:z.number().int().nonnegative(),description:z.string().max(1000),observedText:z.string().max(2000).optional()}).strict()).max(20).parse(captured.actions);
      const status=captured.status==='succeeded'?'succeeded':'failed';
      const reason=[captured.error,error,...(captured.errors || []).map(item=>item.message)].find(value=>typeof value==='string'&&value.trim());
      const chapterResult={repository:chapter.repository,commitSha:chapter.commitSha,status,error:status==='failed'?(reason?.trim().slice(0,1500)||'The application did not complete the recorded check'):null,actions:input.audience==='customer'&&status==='failed'?[]:actions};
      result.chapters.push(chapterResult);
      if(status==='failed') result.status='partial';
      if(input.audience==='internal'||status==='succeeded') {clips.push(media);opened=true;}
      await rm(path.join(safeInput,'source.tar.gz'),{force:true});
    }
    result.mode=allAI?'ai':'scripted';
    if(!clips.length) throw new Error('No successful customer scenes were recorded. Review the private failure footage before generating a customer draft');
    const included=result.chapters.map((chapter,index)=>({chapter,source:input.chapters[index]})).filter(item=>input.audience==='internal'||item.chapter.status==='succeeded');
    const narration=[];
    const segments=[];
    let elapsed=0;
    for(let index=0;index<clips.length;index++) {
      const {chapter,source}=included[index];
      const lines=[];
      if(index===0) {
        lines.push(`${agentTemplates[settings.template].label}${settings.recipient?` for ${settings.recipient}`:''}.`);
        lines.push(settings.narration.kind==='personal'?`This is AI narration using ${settings.narration.name}'s voice with their consent.`:'This recording uses synthetic narration.');
        lines.push(input.audience==='customer'?'This customer update is a private draft for review.':'This recording labels published releases and work in progress.');
        if(settings.brief) lines.push(`The recording owner supplied this context. ${settings.brief}. This context is not an independent inspection of external sources.`);
      }
      lines.push(`${source.state==='released'?'Released update':'Work in progress'}. ${source.heading}. ${source.facts.slice(0,3).join('. ').slice(0,600)}.`);
      for(const action of chapter.actions.filter(action=>action.kind==='assert'&&action.status==='succeeded').slice(0,2)) lines.push(`The recorded check matched the visible text ${action.observedText}.`);
      if(chapter.status==='failed') lines.push(`This demo found a failure. ${(chapter.actions.find(action=>action.status==='failed')?.description || chapter.error || 'The application could not complete its check').slice(0,250)}.`);
      if(index===clips.length-1&&input.audience==='customer'&&result.status==='partial') lines.push('Some scenes were excluded and need review.');
      const text=lines.join(' ');narration.push(text);
      const speech=path.join(resolved,`speech-${index}`);await mkdir(speech,{mode:0o777});await chmod(speech,0o777);await writeFile(path.join(speech,'narration.txt'),text);
      let audio=providers.speech?await providers.speech(text,speech):null;
      if(!audio) {
        assert(settings.narration.kind!=='personal','Personal narration cannot fall back to a different voice. Check your own voice setup before retrying');
        await command([...runArgs(`${network}-speech-${index}`,toolInput),'--interactive','--network','none','--mount',`type=bind,src=${resolved},dst=/out`,built.tag,'espeak-ng','-v','en-us','-s','165','-w',`/out/speech-${index}/narration.wav`,'--stdin'],{input:text,timeout:120_000});
        audio=path.join(speech,'narration.wav');
      }
      await regular(audio,128*1024*1024);
      const clip='/out/'+path.relative(resolved,clips[index]).split(path.sep).join('/');
      const voice='/out/'+path.relative(resolved,audio).split(path.sep).join('/');
      await writeFile(path.join(speech,'media-inputs.json'),JSON.stringify({clip,audio:voice}));
      const probe=await command([...runArgs(`${network}-duration-${index}`,toolInput),'--network','none','--mount',`type=bind,src=${resolved},dst=/out,readonly`,built.tag,'node','-e',`const fs=require('node:fs');const cp=require('node:child_process');const data=JSON.parse(fs.readFileSync('/out/speech-${index}/media-inputs.json'));const duration=file=>Number(cp.execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8'}));const signal=cp.spawnSync('ffmpeg',['-nostdin','-v','info','-threads','1','-i',data.audio,'-vn','-af','volumedetect','-f','null','-'],{encoding:'utf8',timeout:120000,maxBuffer:1048576});const peak=/max_volume: (-?[0-9.]+) dB/.exec(signal.stderr||'');if(signal.status!==0||!peak||Number(peak[1])<=-80) throw new Error('Narration audio has no usable audible signal');console.log(JSON.stringify({clip:duration(data.clip),audio:duration(data.audio),peakDb:Number(peak[1])}));`]);
      const lengths=z.object({clip:z.number().positive().finite(),audio:z.number().positive().finite(),peakDb:z.number().finite()}).parse(JSON.parse(probe.stdout));
      (report.narration||=[]).push({chapter:index,durationMs:Math.round(lengths.audio*1000),peakDb:lengths.peakDb});
      const duration=Math.max(lengths.clip,lengths.audio)+0.15;
      for(const action of chapter.actions) action.positionMs+=Math.round(elapsed*1000);
      elapsed+=duration;
      await command([...runArgs(`${network}-encode-${index}`,toolInput),'--network','none','--mount',`type=bind,src=${resolved},dst=/out`,built.tag,'ffmpeg','-nostdin','-v','error','-i',clip,'-i',voice,'-vf',`tpad=stop_mode=clone:stop_duration=${Math.ceil(duration)}`,'-af','apad','-t',String(duration),'-c:v','libx264','-threads','1','-preset','veryfast','-pix_fmt','yuv420p','-r','30','-c:a','aac','-ar','48000','-ac','2','-movflags','+faststart',`/out/segment-${index}.mp4`],{timeout:12*60_000});
      segments.push(`file '/out/segment-${index}.mp4'`);
    }
    result.narration=narration.join(' ').slice(0,15_000);await writeFile(path.join(resolved,'narration.txt'),result.narration);
    await writeFile(path.join(resolved,'concat.txt'),segments.join('\n')+'\n');
    await command([...runArgs(`${network}-compose`,toolInput),'--network','none','--mount',`type=bind,src=${resolved},dst=/out`,built.tag,'ffmpeg','-nostdin','-v','error','-f','concat','-safe','0','-i','/out/concat.txt','-c','copy','-movflags','+faststart','/out/video.mp4'],{timeout:120_000});
    await regular(path.join(resolved,'video.mp4'),4_900_000_000);
    const probe=await command([...runArgs(`${network}-probe`,toolInput),'--network','none','--mount',`type=bind,src=${resolved},dst=/out,readonly`,built.tag,'ffprobe','-v','error','-show_streams','-show_format','-of','json','/out/video.mp4']);
    const metadata=JSON.parse(probe.stdout);
    assert(metadata.streams.some(stream=>stream.codec_type==='video'&&stream.codec_name==='h264')&&metadata.streams.some(stream=>stream.codec_type==='audio'),'Composed demo needs H.264 video and real narration audio');
    report.media={sha256:await hashFile(path.join(resolved,'video.mp4')),byteLength:(await lstat(path.join(resolved,'video.mp4'))).size,durationMs:Math.round(Number(metadata.format.duration)*1000)};
    assert(report.media.durationMs>0&&report.media.durationMs<=86_400_000,'Composed demo duration is outside the supported media range');
    const parsed=demoResultSchema.parse(result);
    await writeFile(path.join(resolved,'result.json.tmp'),JSON.stringify(parsed,null,2));await rename(path.join(resolved,'result.json.tmp'),path.join(resolved,'result.json'));
    await writeFile(path.join(resolved,'artifact.json'),JSON.stringify(report,null,2));
    completed=true;
    return {result:parsed,...report.media,video:path.join(resolved,'video.mp4')};
  } catch(error) {
    if(!error.message.includes(recordingRetryNotice)) error.message=`${error.message} ${recordingRetryNotice}`;
    await writeFile(path.join(resolved,'failure.json'),JSON.stringify({error:error.message.slice(0,2000),report},null,2));
    throw error;
  } finally {await cleanup();for(let index=0;index<input.chapters.length;index++) await rm(path.join(resolved,`chapter-${index}`,'input','source.tar.gz'),{force:true});await rm(path.join(resolved,'tool-input'),{recursive:true,force:true});await chmod(resolved,0o700);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);providers.signal?.removeEventListener('abort',abort);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  assert(args.length===4&&args[0]==='--input'&&args[2]==='--output','Use --input <job.json> --output <new-directory>');
  const result=await recordDemo(await json(path.resolve(args[1]),1_048_576),path.resolve(args[3]));
  console.log(JSON.stringify({status:result.result.status,video:result.video,sha256:result.sha256,durationMs:result.durationMs}));
}
