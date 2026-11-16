import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { EntryContext } from "react-router";

export default async function handleRequest(request:Request,status:number,headers:Headers,context:EntryContext) {
  const stream=await renderToReadableStream(<ServerRouter context={context} url={request.url}/>,{
    signal:request.signal,onError(error) {console.error("Page render failed",error);status=500;},
  });
  await stream.allReady;
  headers.set("Content-Type","text/html; charset=utf-8");
  headers.set("X-Content-Type-Options","nosniff");
  return new Response(stream,{status,headers});
}
