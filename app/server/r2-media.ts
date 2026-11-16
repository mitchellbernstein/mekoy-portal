import { AwsClient } from "aws4fetch";
import { HttpError } from "./runtime";
import type { Environment, MediaStore, StoredMedia } from "./runtime";
import { previewAsset, previewFormat, previewProfiles, readPreviewBody, type PreviewAsset } from "../../shared/preview";

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2,"0")).join("");

export class R2Media implements MediaStore {
  kind="r2" as const;
  private signer: AwsClient;
  constructor(private bucket: R2Bucket,private env: Environment) {
    if(!env.R2_ACCESS_KEY_ID||!env.R2_SECRET_ACCESS_KEY||!env.R2_BUCKET_NAME||!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("Configure scoped R2 S3 credentials, account and bucket name");
    this.signer=new AwsClient({accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY,service:"s3",region:"auto"});
  }
  private async signed(key: string,method: string,mime?:string,size?:number) {
    const url=new URL(`https://${this.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.env.R2_BUCKET_NAME}/${key}`);
    url.searchParams.set("X-Amz-Expires","900");
    const signed=await this.signer.sign(url,{method,headers:mime?{"Content-Type":mime,...(size?{"Content-Length":String(size)}:{})}:undefined,aws:{signQuery:true,allHeaders:true}});
    return signed.url;
  }
  async prepare(key: string,mime: string,size:number) {return {url:await this.signed(key,"PUT",mime,size),headers:{"Content-Type":mime}};}
  async put(): Promise<never> {throw new HttpError(400,"Use the scoped direct R2 upload URL");}
  async head(key:string) {
    const item=await this.bucket.get(key);if(!item) return null;
    const digest=new crypto.DigestStream("SHA-256");
    const [,hash]=await Promise.all([item.body.pipeTo(digest),digest.digest]);
    const byteLength=Number(digest.bytesWritten);
    if(byteLength!==item.size) throw new HttpError(409,"R2 returned incomplete recording bytes. Retry the saved recording");
    return {byteLength,sha256:hex(hash),etag:item.etag};
  }
  async seal(key:string,finalKey:string,verified:StoredMedia) {
    if(!verified.sha256||!verified.etag) throw new HttpError(409,"Verify the uploaded recording bytes before finalization");
    const source=await this.bucket.get(key,{onlyIf:{etagMatches:verified.etag}});
    if(!source||!("body" in source)) throw new HttpError(409,"Recording changed before finalization. Retry the saved recording");
    if(source.size!==verified.byteLength) {await source.body.cancel();throw new HttpError(409,"Recording length changed before finalization");}
    const item=await this.bucket.put(finalKey,source.body,{sha256:verified.sha256,onlyIf:{etagDoesNotMatch:"*"},httpMetadata:source.httpMetadata}) || await this.bucket.head(finalKey);
    const checksum=item?.checksums.sha256;
    if(!item||!checksum||item.size!==verified.byteLength||hex(checksum)!==verified.sha256) throw new HttpError(409,"R2 did not confirm the exact durable recording");
    return {byteLength:item.size,sha256:hex(checksum),etag:item.etag};
  }
  async read(key: string,request: Request,mime:string) {
    const item=await this.bucket.get(key,{range:request.headers}); if(!item) throw new HttpError(404,"Recording not found");
    const headers=new Headers({"Content-Type":mime,"Accept-Ranges":"bytes","Cache-Control":"private, no-store"});
    let status=200; let length=item.size;
    if(item.range) {
      const range=item.range as {offset:number;length:number};
      const start=range.offset||0;length=range.length??item.size-start;
      headers.set("Content-Range",`bytes ${start}-${start+length-1}/${item.size}`);status=206;
    }
    headers.set("Content-Length",String(length));
    return new Response(request.method==="HEAD"?null:item.body,{status,headers});
  }
  async source(key:string) {return {url:await this.signed(key,"GET")};}
  async readPreview(key: string): Promise<PreviewAsset | null> {
    const format = previewFormat(key); const item = await this.bucket.get(key);
    if (!item) return null;
    if (item.size > previewProfiles[format].maxBytes) { await item.body.cancel(); return null; }
    return readPreviewBody(new Response(item.body, { headers: { "Content-Type": item.httpMetadata?.contentType || "", "Content-Length": String(item.size) } }), format);
  }
  async writePreview(key: string, asset: PreviewAsset) {
    const format = previewFormat(key);
    if (!previewAsset(asset.bytes, format) || asset.contentType !== previewProfiles[format].contentType) throw new Error("Invalid preview image");
    await this.bucket.put(key, asset.bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: asset.contentType, cacheControl: "private, no-store" } });
  }
}
