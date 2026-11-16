export type PreviewFormat = "jpg" | "gif";
export type PreviewAsset = { bytes: Uint8Array<ArrayBuffer>; contentType: "image/jpeg" | "image/gif" };
export const previewProfiles = {
  jpg: { contentType: "image/jpeg", maxBytes: 65_536 },
  gif: { contentType: "image/gif", maxBytes: 524_288 },
} as const;

export function previewFormat(key: string): PreviewFormat {
  const match = /^previews\/v1\/[a-zA-Z0-9_-]{1,100}\.[a-zA-Z0-9_-]{1,100}\.(jpg|gif)$/.exec(key);
  if (!match) throw new Error("Invalid preview storage key");
  return match[1] as PreviewFormat;
}
export function previewKey(videoId: string, receiptId: string, format: PreviewFormat) {
  const key = `previews/v1/${videoId}.${receiptId}.${format}`;
  previewFormat(key);
  return key;
}
export function previewAsset(bytes: Uint8Array<ArrayBuffer>, format: PreviewFormat): PreviewAsset | null {
  const signature = format === "gif"
    ? bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return signature && bytes.byteLength <= previewProfiles[format].maxBytes ? { bytes, contentType: previewProfiles[format].contentType } : null;
}
export async function readPreviewBody(response: Response, format: PreviewFormat): Promise<PreviewAsset | null> {
  const profile = previewProfiles[format];
  if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== profile.contentType || Number(response.headers.get("content-length")) > profile.maxBytes || !response.body) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > profile.maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return previewAsset(bytes, format);
}
