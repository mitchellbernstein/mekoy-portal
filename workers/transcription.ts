import type { Runtime } from "../app/server/runtime";
import { ProviderError } from "../app/server/slack";

export function workersAiTranscription(binding: Pick<Ai, "run">): NonNullable<Runtime["transcribeAudio"]> {
  return async (audio, signal) => {
    try {
      signal.throwIfAborted();
      const response = await binding.run("@cf/deepgram/nova-3", { audio, smart_format: true, punctuate: true }, { signal, returnRawResponse: true });
      if (!response.ok) {
        let code: number | undefined;
        try {
          const error = await response.json<{ internalCode?: number; errors?: { code?: number }[] }>();
          const value = error?.internalCode ?? error?.errors?.[0]?.code;
          if (value !== undefined && Number.isSafeInteger(value)) code = value;
        } catch {}
        const blocked = [400, 401, 403, 404, 405, 410, 413].includes(response.status) || code === 3036;
        const action = code === 3036 ? "Workers AI allowance is exhausted. Enable billing or wait for the quota reset."
          : [401, 403].includes(response.status) ? "Workers AI transcription access was denied. Check the AI binding and account access."
          : response.status === 413 ? "Workers AI rejected the recording size. Retry with a smaller recording."
          : blocked ? "Workers AI rejected transcription. Check the model and recording format before retrying."
          : "Workers AI transcription could not finish. Retry processing.";
        const retry = Number(response.headers.get("retry-after"));
        throw new ProviderError(`${action} HTTP ${response.status}${code === undefined ? "" : `, code ${code}`}.`, false, response.status === 429 && !blocked ? Math.min(3600, Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60) : 0, blocked);
      }
      const result = await response.json();
      if (!result || typeof result !== "object") throw new Error("Invalid transcription response");
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted) throw new ProviderError("Workers AI transcription was cancelled. Retry processing.");
      if (error instanceof Error && error.name === "TimeoutError") throw new ProviderError("Workers AI transcription timed out. Retry processing.");
      throw new ProviderError("Workers AI transcription did not complete. Retry processing.");
    }
  };
}
