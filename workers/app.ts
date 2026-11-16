import { createRequestHandler, RouterContextProvider } from "react-router";
import { runtimeContext } from "../app/runtime-context";
import { handleApi } from "../app/server/api";
import { createAuth, createPool } from "../app/server/runtime";
import type { Environment, Runtime } from "../app/server/runtime";
import { R2Media } from "../app/server/r2-media";
import { dispatchOutbox, runJobs } from "../app/server/jobs";
import { workersAiTranscription } from "./transcription";

interface Bindings { HYPERDRIVE:Hyperdrive; ORIGINALS:R2Bucket; JOBS:Queue<{id:string}>; ASSETS:Fetcher; AI?:Ai; [key:string]:unknown }
function runtime(env:Bindings):Runtime {
  const values=Object.fromEntries(Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==="string")) as Environment;
  const db=createPool(env.HYPERDRIVE.connectionString);
  return {db,env:values,auth:createAuth(db,values),storage:new R2Media(env.ORIGINALS,values),transcribeAudio:env.AI?workersAiTranscription(env.AI):undefined,enqueue:async(id)=>{await env.JOBS.send({id});}};
}
const handler=createRequestHandler(()=>import("virtual:react-router/server-build"),import.meta.env.MODE);
export default {
  async fetch(request:Request,env:Bindings,ctx:ExecutionContext) {
    const url=new URL(request.url);
    if((request.method==="GET"||request.method==="HEAD")&&typeof env.APP_ORIGIN==="string"&&url.origin!==new URL(env.APP_ORIGIN).origin) {
      const canonical=new URL(env.APP_ORIGIN);
      canonical.pathname=url.pathname;canonical.search=url.search;
      return Response.redirect(canonical.href,308);
    }
    const app=runtime(env);
    app.defer=work=>ctx.waitUntil(work);
    if(url.pathname==="/api/mcp") {
      try {return await handleApi(request,app);} finally {ctx.waitUntil(app.db.end());}
    }
    if(url.pathname.startsWith("/api/")) {
      const response=await handleApi(request,app);
      ctx.waitUntil(dispatchOutbox(app).catch(error=>console.error("Outbox dispatch deferred to retry sweep",error)).finally(()=>app.db.end()));
      return response;
    }
    try {
      const context=new RouterContextProvider();context.set(runtimeContext,app);
      return await handler(request,context);
    } finally {ctx.waitUntil(app.db.end());}
  },
  async queue(batch:MessageBatch<{id:string}>,env:Bindings) {
    const app=runtime(env);
    try {for(const message of batch.messages) {await runJobs(app,1,message.body.id);message.ack();}await dispatchOutbox(app);} finally {await app.db.end();}
  },
  async scheduled(_event:ScheduledController,env:Bindings) {
    const app=runtime(env);try {await dispatchOutbox(app);} finally {await app.db.end();}
  },
} satisfies ExportedHandler<Bindings,{id:string}>;
