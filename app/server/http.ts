import { z } from "zod";
import { HttpError } from "./runtime";

export async function readBody(request:Request,maxBytes=131_072):Promise<Uint8Array<ArrayBuffer>> {
  const reader=request.body?.getReader();let size=0; const chunks:Uint8Array[]=[];
  try {
    if(Number(request.headers.get("content-length"))>maxBytes) throw new HttpError(413,"Request is too large");
    if(reader) for(;;) {const {done,value}=await reader.read();if(done) break;size+=value.byteLength;if(size>maxBytes) throw new HttpError(413,"Request is too large");chunks.push(value);}
  } catch(error) {await reader?.cancel().catch(()=>{});throw error;}
  finally {reader?.releaseLock();}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks) {all.set(chunk,offset);offset+=chunk.length;}
  return all;
}
export async function body<T>(request:Request,schema:z.ZodType<T>,maxBytes=131_072):Promise<T> {
  if(!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(400,"Send JSON with Content-Type application/json");
  const all=await readBody(request,maxBytes);
  try {return schema.parse(JSON.parse(new TextDecoder().decode(all)));}
  catch(error) {if(error instanceof z.ZodError) throw new HttpError(400,error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; "));throw new HttpError(400,"Invalid JSON request");}
}
export const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
