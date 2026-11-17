import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { TransformStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { createRequestHandler, RouterContextProvider } from "react-router";
import { runtimeContext } from "../app/runtime-context";
import { createAuth, createPool } from "../app/server/runtime";
import type { Runtime } from "../app/server/runtime";
import { handleApi } from "../app/server/api";
import { runJobs } from "../app/server/jobs";
import { LocalMedia } from "./local-media";

const env=process.env;
if(!env.DATABASE_URL) throw new Error("Set DATABASE_URL, then run npm run db:migrate");
const port=Number(env.PORT||4783);const db=createPool(env.DATABASE_URL);
const runtime:Runtime={db,auth:createAuth(db,env),env,storage:new LocalMedia(path.resolve(env.MEDIA_ROOT||".local/media"))};
const production=env.NODE_ENV==="production";const apiOnly=env.E2E_API_ONLY==="1";
const vite=!production&&!apiOnly?await import("vite").then(v=>v.createServer({server:{middlewareMode:true},appType:"custom"})):null;
const handler=apiOnly?null:createRequestHandler(production?await import(path.resolve("build/server/index.js")):()=>vite!.ssrLoadModule("virtual:react-router/server-build") as never,production?"production":"development");
const mime:Record<string,string>={".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".mp4":"video/mp4",".json":"application/json",".woff2":"font/woff2",".ico":"image/x-icon"};
const publicMedia=new LocalMedia(path.resolve("build/client"));
async function serve(req:http.IncomingMessage,res:http.ServerResponse) {
  const pathname=new URL(req.url||"/",env.APP_ORIGIN||`http://127.0.0.1:${port}`).pathname;
  if(production&&!apiOnly&&!pathname.startsWith("/api/")) {
    const filename=path.resolve("build/client",`.${decodeURIComponent(pathname)}`);
    if(filename.startsWith(path.resolve("build/client")+path.sep)) try {
      const details=await stat(filename);
      if(details.isFile()) {
        if(mime[path.extname(filename)]==="video/mp4") {
          const headers=new Headers();if(req.headers.range) headers.set("Range",req.headers.range);
          const request=new Request(new URL(req.url||"/",env.APP_ORIGIN||`http://127.0.0.1:${port}`),{method:req.method,headers});
          const response=await publicMedia.read(path.relative(path.resolve("build/client"),filename),request,mime[".mp4"]);
          response.headers.set("Cache-Control","no-cache");res.writeHead(response.status,Object.fromEntries(response.headers));
          if(response.body) await pipeline(Readable.fromWeb(response.body as never),res);else res.end();
          return;
        }
        res.writeHead(200,{"Content-Type":mime[path.extname(filename)]||"application/octet-stream","Content-Length":details.size,"Cache-Control":pathname.startsWith("/assets/")?"public, max-age=31536000, immutable":"no-cache"});await pipeline(createReadStream(filename),res);return;
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  }
  const controller=new AbortController();req.once("aborted",()=>controller.abort());
  res.once("close",()=>{if(!res.writableEnded) controller.abort();});
  const headers=new Headers();for(const [name,value] of Object.entries(req.headers)) {if(Array.isArray(value)) for(const item of value) headers.append(name,item);else if(value) headers.set(name,value);}
  const hasBody=req.method!=="GET"&&req.method!=="HEAD";
  // Preserve the socket until a cancelled request body receives its error response.
  const request=new Request(new URL(req.url||"/",env.APP_ORIGIN||`http://127.0.0.1:${port}`),{method:req.method,headers,signal:controller.signal,...(hasBody?{body:Readable.toWeb(req,{strategy:{size:chunk=>chunk.byteLength}}).pipeThrough(new TransformStream(),{preventCancel:true}) as ReadableStream<Uint8Array>,duplex:"half"}:{})} as RequestInit);
  const context=new RouterContextProvider();context.set(runtimeContext,runtime);
  const response=pathname.startsWith("/api/")?await handleApi(request,runtime):handler?await handler(request,context):new Response("API test runtime",{status:404});
  if(request.body&&!request.body.locked) {
    void request.body.pipeTo(new WritableStream()).catch(error=>{if(!req.aborted) console.error("Request body discard failed",error);});
  }
  if(request.signal.aborted) return;
  if(response.status===413&&!req.complete) res.shouldKeepAlive=false;
  res.statusCode=response.status;res.statusMessage=response.statusText;
  for(const [key,value] of response.headers) {if(key!=="set-cookie") res.setHeader(key,value);}
  const cookies=response.headers.getSetCookie();if(cookies.length) res.setHeader("set-cookie",cookies);
  if(response.body) await pipeline(Readable.fromWeb(response.body as never),res);else res.end();
}
const server=http.createServer((req,res)=>{
  if(vite&&!req.url?.startsWith("/api/")) vite.middlewares(req,res,()=>{void serve(req,res).catch(error=>{console.error(error);if(!res.headersSent) res.writeHead(500);res.end("Request failed");});});
  else void serve(req,res).catch(error=>{if(!req.aborted) console.error(error);if(!res.headersSent) res.writeHead(500);res.end("Request failed");});
});
server.requestTimeout=30*60*1000;
server.listen(port,env.HOST||"127.0.0.1",()=>console.log(`Video workspace listening on ${env.APP_ORIGIN||`http://127.0.0.1:${port}`} pid=${process.pid}`));
let jobsActive=false;
const timer=env.JOBS_AUTORUN==="0"?null:setInterval(()=>{if(jobsActive) return;jobsActive=true;void runJobs(runtime,3).catch(error=>console.error("Job runner failed",error.message)).finally(()=>{jobsActive=false;});},5000);
timer?.unref();
async function shutdown() {if(timer) clearInterval(timer);server.close();await vite?.close();await db.end();process.exit(0);}
process.once("SIGTERM",()=>void shutdown());process.once("SIGINT",()=>void shutdown());
