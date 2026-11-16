import { z } from "zod";
import type { Runtime } from "./runtime";
import { ProviderError } from "./slack";
import type { Word } from "../../shared/contracts";

export const transcriptionSetup = "Configure the Workers AI binding AI for Cloudflare hosting, or set DEEPGRAM_API_KEY for Node word-aligned transcription";
export function transcriptionProvider(runtime: Pick<Runtime, "transcribeAudio" | "env">) { return runtime.transcribeAudio ? "Workers AI Nova-3" : runtime.env.DEEPGRAM_API_KEY ? "Deepgram" : null; }

export async function transcribe(runtime: Runtime, video: { storage_key: string; mime_type: string; duration_ms: number; byte_length: string | number }): Promise<Word[]> {
  const source = await runtime.storage.source(video.storage_key, video.mime_type).catch(error => {
    if (!runtime.transcribeAudio) throw error;
    throw new ProviderError("Recording source could not be opened. Retry the retained original.");
  });
  const signal = AbortSignal.timeout(300_000);
  let result;
  if (runtime.transcribeAudio) {
    try {
      let body: ReadableStream<Uint8Array>;
      if ("url" in source) {
        const response = await fetch(source.url, { signal });
        if (!response.ok) { await response.body?.cancel(); throw new ProviderError(`Recording source returned ${response.status}. Retry the retained original or restore storage access.`, false, 0, [400, 401, 403, 404, 410].includes(response.status)); }
        if (!response.body) throw new ProviderError("Recording source contained no media. Retry the retained original.", false, 0, true);
        body = response.body;
      } else body = source.body;
      let received = 0;
      const expected = Number(video.byte_length);
      const verified = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { received += chunk.byteLength; if (received > expected) throw new ProviderError("Recording source exceeded its durable byte length. Retry the retained original."); controller.enqueue(chunk); },
        flush() { if (received !== expected) throw new ProviderError("Recording source was incomplete. Retry the retained original."); },
      }), { signal });
      try {
        result = await runtime.transcribeAudio({ body: verified, contentType: video.mime_type }, signal);
        if (received !== expected) throw new ProviderError("Recording source was incomplete. Retry the retained original.");
      } finally { if (!verified.locked) await verified.cancel().catch(() => {}); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? "Workers AI transcription timed out. Retry processing." : "Recording source could not be transcribed. Retry the retained original.");
    }
  } else {
    const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true", {
      method: "POST", headers: { Authorization: `Token ${runtime.env.DEEPGRAM_API_KEY}`, "Content-Type": "url" in source ? "application/json" : video.mime_type },
      body: "url" in source ? JSON.stringify({ url: source.url }) : source.body, ...("body" in source ? { duplex: "half" as const } : {}), signal,
    } as RequestInit);
    if (!response.ok) throw new ProviderError(`Deepgram returned ${response.status}. Verify the API key and recording audio`, false, 0, [400, 401, 403].includes(response.status));
    result = await response.json();
  }
  const array = (result as { results?: { channels?: { alternatives?: { words?: unknown }[] }[] } }).results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(array)) throw new ProviderError(`${runtime.transcribeAudio ? "Workers AI" : "Deepgram"} returned no word array. Transcript was not fabricated`, false, 0, true);
  try {
    const parsed = z.array(z.object({ word: z.string(), punctuated_word: z.string().optional(), start: z.number().nonnegative(), end: z.number().nonnegative() }).refine(w => w.end >= w.start)).max(500_000).parse(array);
    return parsed.map(w => ({ word: w.punctuated_word || w.word, startMs: Math.round(w.start * 1000), endMs: Math.round(w.end * 1000) })).filter(w => w.startMs <= video.duration_ms + 2000);
  } catch (error) {
    if (!runtime.transcribeAudio) throw error;
    throw new ProviderError("Workers AI returned invalid transcript words or timings. Retry processing.");
  }
}
