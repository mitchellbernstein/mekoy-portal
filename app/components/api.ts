import { useCallback, useEffect, useState } from "react";
import type { ApiSeed } from "../../shared/contracts";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

type ApiTransport = { request: (path: string, options: RequestInit) => Promise<unknown>; origin: () => string | null };
let transport: ApiTransport | null = null;

export function configureApiTransport(value: ApiTransport | null) { transport = value; }

export function workspaceOrigin() {
  return transport ? transport.origin() || "" : typeof window === "undefined" ? "" : window.location.origin;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (transport) {
    options.signal?.throwIfAborted();
    const request = transport.request(path, options);
    if (!options.signal) return await request as T;
    const signal = options.signal;
    return await new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new DOMException("The request was aborted.", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      request.then(value => { if (!signal.aborted) resolve(value as T); }, reject).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
  }
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof body?.error === "string" ? body.error : body?.error?.message || body?.message || `Request failed (${response.status}).`, response.status);
  return body as T;
}

export function write<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export type { ApiSeed } from "../../shared/contracts";

export function useApi<T>(path: string, initialData?: ApiSeed<T> | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ path: string; data: T | null; error: string; loading: boolean }>(() => initialData?.path === path ? { ...initialData, loading: false } : { path, data: null, error: "", loading: true });
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (revision === 0 && initialData?.path === path) {
      setState({ ...initialData, loading: false });
      return;
    }
    const controller = new AbortController();
    setState(previous => ({ path, data: previous.path === path ? previous.data : null, error: "", loading: true }));
    api<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ path, data, error: "", loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, data: null, error: errorMessage(error), loading: false });
    });
    return () => controller.abort();
  }, [path, revision, initialData]);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : "", loading: state.path !== path || state.loading, reload };
}

export function time(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  return hours ? `${hours}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function date(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function videoPath(id: string, positionMs?: number | null) {
  return `/videos/${encodeURIComponent(id)}${positionMs == null ? "" : `?t=${positionMs}`}`;
}
