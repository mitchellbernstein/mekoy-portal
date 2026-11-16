import type { User } from "../../shared/contracts";
import { previewKey, readPreviewBody, type PreviewAsset, type PreviewFormat } from "../../shared/preview";
import { accessibleVideo, streamToken } from "./domain";
import { HttpError, type Runtime } from "./runtime";

const hostedWork = new Map<string, Promise<PreviewAsset | null>>();
const hostedFailures = new Map<string, number>();
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const unavailable = () => new Response(null, { status: 204, headers });
type PreviewStage = "token" | "download" | "validate" | "store";
function reportFailure(stage: PreviewStage, format: PreviewFormat, error: unknown) {
  const errorName = error instanceof Error && ["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "HttpError"].includes(error.name) ? error.name : "Error";
  console.warn("Preview unavailable", { stage, format, errorName });
}

async function hostedPreview(runtime: Runtime, key: string, uid: string, format: PreviewFormat): Promise<PreviewAsset | null> {
  if (!runtime.env.CLOUDFLARE_ACCOUNT_ID || !runtime.env.CLOUDFLARE_API_TOKEN || !runtime.storage.writePreview || !/^[a-zA-Z0-9_-]{1,240}$/.test(uid)) return null;
  const identity = `${runtime.env.CLOUDFLARE_ACCOUNT_ID}/${key}`;
  const existing = hostedWork.get(identity);
  if (existing) { runtime.defer?.(existing); return existing; }
  if (hostedWork.size >= 3 || (hostedFailures.get(identity) || 0) > Date.now()) return null;
  const work = (async () => {
    let asset: PreviewAsset | null = null;
    let stage: PreviewStage = "token";
    try {
      const token = await streamToken(runtime, uid, Math.floor(Date.now() / 1000) + 60, 3000);
      if (token.length > 16_384 || !/^[a-zA-Z0-9_.-]+$/.test(token)) throw new TypeError("Invalid Stream token shape");
      const url = new URL(`https://videodelivery.net/${encodeURIComponent(token)}/thumbnails/thumbnail.${format}`);
      url.searchParams.set("time", "0s"); url.searchParams.set("width", "320"); url.searchParams.set("height", "320"); url.searchParams.set("fit", "clip");
      if (format === "gif") { url.searchParams.set("duration", "4s"); url.searchParams.set("fps", "6"); }
      stage = "download";
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
      stage = "validate";
      asset = await readPreviewBody(response, format);
      if (!asset) console.warn("Preview unavailable", { stage: response.ok ? "validate" : "download", format, status: response.status });
      if (asset) { stage = "store"; await runtime.storage.writePreview!(key, asset); }
    } catch (error) { reportFailure(stage, format, error); asset = null; }
    finally {
      hostedWork.delete(identity);
      if (!asset) { if (hostedFailures.size >= 128) hostedFailures.delete(hostedFailures.keys().next().value!); hostedFailures.set(identity, Date.now() + 30_000); }
    }
    return asset;
  })();
  hostedWork.set(identity, work); runtime.defer?.(work); return work;
}

export async function servePreview(runtime: Runtime, user: User, videoId: string, request: Request): Promise<Response> {
  const url = new URL(request.url); const format = url.searchParams.get("format") || "jpg";
  if ((format !== "jpg" && format !== "gif") || url.searchParams.getAll("format").length > 1) throw new HttpError(400, "Choose the jpg or gif preview format");
  const video = await accessibleVideo(runtime.db, videoId, user.id);
  if (video.upload_state !== "uploaded" || !video.receipt_id || !runtime.storage.readPreview) return unavailable();
  const key = previewKey(video.id, video.receipt_id, format);
  let asset: PreviewAsset | null = null;
  try {
    asset = await runtime.storage.readPreview(key);
    if (!asset && request.method !== "HEAD") {
      if (runtime.storage.kind === "local") asset = await runtime.storage.generatePreview?.(video.storage_key, key) || null;
      else if (video.processing_status === "stream_ready" && video.stream_uid) asset = await hostedPreview(runtime, key, video.stream_uid, format);
    }
  } catch (error) { if (runtime.storage.kind === "r2") reportFailure("store", format, error); asset = null; }
  await accessibleVideo(runtime.db, videoId, user.id);
  if (!asset || request.signal.aborted) return unavailable();
  return new Response(request.method === "HEAD" ? null : asset.bytes, { headers: { ...headers, "Content-Type": asset.contentType, "Content-Length": String(asset.bytes.byteLength) } });
}
