import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { HttpError } from "../app/server/runtime";
import type { MediaStore } from "../app/server/runtime";
import { previewAsset, previewFormat, previewProfiles, type PreviewAsset } from "../shared/preview";

type PreviewTask = { key: string; source: string; deadline: number; promise: Promise<PreviewAsset | null>; resolve: (asset: PreviewAsset | null) => void; timer: ReturnType<typeof setTimeout> };

export class LocalMedia implements MediaStore {
  kind = "local" as const;
  constructor(private root: string) {}
  private previewJobs = new Map<string, PreviewTask>();
  private previewQueue: PreviewTask[] = [];
  private previewActive: PreviewTask | null = null;
  private previewFailures = new Map<string, number>();
  private location(key: string) {
    if (!/^[a-zA-Z0-9/_-]+\.mp4$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    return path.join(this.root,key);
  }
  async prepare(_key: string, mime: string, _size: number, request: Request, videoId: string) {
    return {url:new URL(`/api/uploads/${videoId}/bytes`,request.url).toString(),headers:{"Content-Type":mime}};
  }
  async put(key: string, request: Request, expectedSize: number) {
    if (!request.body) throw new HttpError(400,"Recording body is missing");
    const filename=this.location(key); await mkdir(path.dirname(filename),{recursive:true});
    const temporary=`${filename}.${randomUUID()}.partial`;
    const digest=createHash("sha256"); let received=0;
    const counter=new Transform({transform(chunk, _encoding, callback) {
      received+=chunk.length;
      if(received>expectedSize) return callback(new HttpError(400,"Recording exceeds declared length"));
      digest.update(chunk); callback(null,chunk);
    }});
    try {
      await pipeline(Readable.fromWeb(request.body as never),counter,createWriteStream(temporary,{flags:"wx",mode:0o600}));
      if(received!==expectedSize) throw new HttpError(400,"Recording length does not match. Retry the saved file");
      const file=await open(temporary,"r+"); try {await file.sync();} finally {await file.close();}
      await rename(temporary,filename);
      const directory=await open(path.dirname(filename),"r"); try {await directory.sync();} finally {await directory.close();}
      return {byteLength:received,sha256:digest.digest("hex")};
    } catch(error) {await rm(temporary,{force:true}); throw error;}
  }
  async head(key: string) {
    try {const details=await stat(this.location(key)); return {byteLength:details.size,sha256:null};}
    catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") return null; throw error;}
  }
  async read(key: string, request: Request, mime: string) {
    const details=await this.head(key); if(!details) throw new HttpError(404,"Recording file not found");
    const range=request.headers.get("range"); let start=0; let end=details.byteLength-1;
    if(range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match || (!match[1]&&!match[2])) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${details.byteLength}`}});
      if(!match[1]) start=Math.max(0,details.byteLength-Number(match[2]));
      else {start=Number(match[1]); if(match[2]) end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||start>end||start>=details.byteLength) return new Response(null,{status:416,headers:{"Content-Range":`bytes */${details.byteLength}`}});
    }
    const headers:Record<string,string>={"Content-Type":mime,"Content-Length":String(end-start+1),"Accept-Ranges":"bytes","Cache-Control":"private, no-store"};
    if(range) headers["Content-Range"]=`bytes ${start}-${end}/${details.byteLength}`;
    const body=request.method==="HEAD" ? null : Readable.toWeb(createReadStream(this.location(key),{start,end})) as ReadableStream<Uint8Array>;
    return new Response(body,{status:range?206:200,headers});
  }
  async source(key: string) {return {body:Readable.toWeb(createReadStream(this.location(key))) as ReadableStream<Uint8Array>};}
  private previewLocation(key: string) { previewFormat(key); return path.join(this.root, key); }
  async readPreview(key: string): Promise<PreviewAsset | null> {
    const format = previewFormat(key); const filename = this.previewLocation(key);
    let file;
    try { file = await open(filename, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const details = await file.stat();
      if (!details.isFile() || details.size > previewProfiles[format].maxBytes) return null;
      const asset = previewAsset(new Uint8Array(await file.readFile()), format);
      if (asset) { const now = new Date(); await file.utimes(now, now).catch(() => {}); }
      return asset;
    } finally { await file.close(); }
  }
  async writePreview(key: string, asset: PreviewAsset) {
    const format = previewFormat(key);
    if (!previewAsset(asset.bytes, format) || asset.contentType !== previewProfiles[format].contentType) throw new Error("Invalid preview image");
    const filename = this.previewLocation(key); await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, asset.bytes, { flag: "wx", mode: 0o600 });
      try { await link(temporary, filename); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV" || code === "ENOSYS") await rename(temporary, filename);
        else if (code !== "EEXIST") throw error;
      }
    } finally { await rm(temporary, { force: true }); }
    const directory = path.dirname(filename);
    const files = await Promise.all((await readdir(directory)).filter(name => /^[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9_-]{1,100}\.(jpg|gif)$/.test(name)).map(async name => {
      const filename = path.join(directory, name); const info = await stat(filename); return { filename, size: info.size, time: info.mtimeMs };
    }));
    let size = files.reduce((total, file) => total + file.size, 0); let count = files.length;
    for (const file of files.sort((a, b) => a.time - b.time)) {
      if (size <= 33_554_432 && count <= 4096) break;
      await rm(file.filename, { force: true }); size -= file.size; count--;
    }
  }
  generatePreview(sourceKey: string, key: string): Promise<PreviewAsset | null> {
    previewFormat(key); const source = this.location(sourceKey);
    const existing = this.previewJobs.get(key); if (existing) return existing.promise;
    if ((this.previewFailures.get(key) || 0) > Date.now() || this.previewActive && this.previewQueue.length >= 2) return Promise.resolve(null);
    let resolve!: PreviewTask["resolve"];
    const promise = new Promise<PreviewAsset | null>(done => { resolve = done; });
    const task: PreviewTask = { key, source, deadline: Date.now() + 15_000, promise, resolve, timer: setTimeout(() => {
      resolve(null);
      if (this.previewActive !== task) { this.previewQueue = this.previewQueue.filter(item => item !== task); this.previewJobs.delete(key); }
    }, 15_000) };
    this.previewJobs.set(key, task); this.previewQueue.push(task); this.runPreview(); return promise;
  }
  private runPreview() {
    if (this.previewActive) return;
    const task = this.previewQueue.shift(); if (!task) return;
    this.previewActive = task;
    void (async () => {
      let asset: PreviewAsset | null = null; let failed = false;
      try {
        asset = await this.readPreview(task.key);
        if (!asset && Date.now() < task.deadline) { asset = await this.encodePreview(task); if (asset) await this.writePreview(task.key, asset); }
      } catch { failed = true; }
      finally {
        clearTimeout(task.timer);
        if (!asset || failed) { if (this.previewFailures.size >= 128) this.previewFailures.delete(this.previewFailures.keys().next().value!); this.previewFailures.set(task.key, Date.now() + 30_000); }
        task.resolve(asset); this.previewJobs.delete(task.key); this.previewActive = null; this.runPreview();
      }
    })();
  }
  private encodePreview(task: PreviewTask): Promise<PreviewAsset | null> {
    const format = previewFormat(task.key); const profile = previewProfiles[format];
    const scale = "scale=320:320:force_original_aspect_ratio=decrease:flags=bilinear";
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-max_pixels", "33554432", "-t", "4", "-i", task.source, "-map", "0:v:0", "-an", "-sn", "-dn"];
    args.push(...(format === "gif" ? ["-vf", `fps=6,${scale},split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`, "-frames:v", "24", "-loop", "0", "-f", "gif"] : ["-vf", scale, "-frames:v", "1", "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg"]), "-threads", "1", "pipe:1");
    return new Promise(resolve => {
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let size = 0; let errors = 0; let failed = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500); };
      const timer = setTimeout(kill, Math.max(1, task.deadline - Date.now()));
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > profile.maxBytes) kill(); else chunks.push(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.byteLength; if (errors > 16_384) kill(); });
      child.once("error", () => { failed = true; });
      child.once("close", code => { clearTimeout(timer); clearTimeout(killTimer); resolve(!failed && code === 0 ? previewAsset(new Uint8Array(Buffer.concat(chunks)), format) : null); });
    });
  }
  async frames(key: string, durationMs: number) {
    const frames:{positionMs:number;bytes:Uint8Array}[]=[];
    for(let positionMs=0;positionMs<durationMs;positionMs+=Math.max(10_000,Math.ceil(durationMs/12))) {
      const bytes=await new Promise<Buffer>((resolve,reject)=>{
        const child=spawn("ffmpeg",["-hide_banner","-loglevel","error","-ss",String(positionMs/1000),"-i",this.location(key),"-frames:v","1","-vf","scale=960:-2","-threads","1","-f","image2pipe","-vcodec","mjpeg","pipe:1"],{stdio:["ignore","pipe","pipe"]});
        const chunks:Buffer[]=[]; let size=0; let error="";
        child.stdout.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>4_000_000) child.kill("SIGTERM");else chunks.push(chunk);});
        child.stderr.on("data",d=>{error+=d;}); child.once("error",reject);
        child.once("exit",code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error(`Frame extraction failed: ${error.slice(0,200)}`)));
      });
      if(bytes.length) frames.push({positionMs,bytes});
    }
    return frames;
  }
}
