import pg from "pg";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import type { User } from "../../shared/contracts";
import type { PreviewAsset } from "../../shared/preview";

export type Environment = Record<string, string | undefined>;
export type StoredMedia = { byteLength: number; sha256: string | null; etag?: string };
export interface MediaStore {
  kind: "local" | "r2";
  prepare(key: string, mime: string, size: number, request: Request, videoId: string): Promise<{url: string; headers: Record<string,string>}>;
  put(key: string, request: Request, expectedSize: number): Promise<StoredMedia>;
  head(key: string): Promise<StoredMedia | null>;
  seal?(key: string, finalKey: string, verified: StoredMedia): Promise<StoredMedia>;
  read(key: string, request: Request, mime: string): Promise<Response>;
  source(key: string, mime: string): Promise<{url: string} | {body: ReadableStream<Uint8Array>}>;
  frames?(key: string, durationMs: number): Promise<{positionMs:number; bytes:Uint8Array}[]>;
  readPreview?(key: string): Promise<PreviewAsset | null>;
  writePreview?(key: string, asset: PreviewAsset): Promise<void>;
  generatePreview?(sourceKey: string, key: string): Promise<PreviewAsset | null>;
}
export type Runtime = {
  db: pg.Pool; auth: ReturnType<typeof createAuth>; storage: MediaStore; env: Environment;
  transcribeAudio?: (audio: { body: ReadableStream<Uint8Array>; contentType: string }, signal: AbortSignal) => Promise<unknown>;
  enqueue?: (id: string) => Promise<void>;
  defer?: (work: Promise<unknown>) => void;
};
export type Sql = Pick<pg.Pool, "query"> | pg.PoolClient;
export function createAuth(db: pg.Pool, env: Environment) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("Set BETTER_AUTH_SECRET to at least 32 random characters");
  const defaultPlan=env.DEFAULT_ACCOUNT_PLAN||"workspace";
  if(defaultPlan!=="free"&&defaultPlan!=="workspace") throw new Error("Set DEFAULT_ACCOUNT_PLAN to free or workspace");
  const origin = env.APP_ORIGIN || env.BETTER_AUTH_URL || "http://127.0.0.1:4783";
  return betterAuth({ database: db, baseURL: origin, secret: env.BETTER_AUTH_SECRET,
    user: { additionalFields: { workspacePlan: { type: ["free","workspace"], required: false, defaultValue: defaultPlan, input: false, returned: false } } },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    plugins: [bearer({ requireSignature: true })], trustedOrigins: [origin],
    session: { cookieCache: { enabled: false } },
  });
}
export function createPool(connectionString: string) {
  return new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function currentUser(request: Request, runtime: Runtime): Promise<User> {
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, "Sign in to continue");
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}
export async function transaction<T>(db: pg.Pool, fn: (db: pg.PoolClient) => Promise<T>) {
  const connection = await db.connect();
  try { await connection.query("BEGIN"); const result = await fn(connection); await connection.query("COMMIT"); return result; }
  catch (error) { await connection.query("ROLLBACK"); throw error; }
  finally { connection.release(); }
}
export function origin(runtime: Runtime) { return (runtime.env.APP_ORIGIN || "http://127.0.0.1:4783").replace(/\/$/, ""); }
export const uuid = () => crypto.randomUUID();
export async function enqueue(db: Sql, kind: string, videoId: string | null, operationKey: string, payload: unknown = {}) {
  const id = uuid();
  const result = await db.query("INSERT INTO jobs(id,kind,video_id,operation_key,payload) SELECT $1,$2,$3,$4,$5 WHERE $3::text IS NULL OR EXISTS(SELECT 1 FROM videos WHERE id=$3 AND deleted_at IS NULL) ON CONFLICT(operation_key) DO UPDATE SET operation_key=excluded.operation_key RETURNING id", [id,kind,videoId,operationKey,JSON.stringify(payload)]);
  if (!result.rows[0]) throw new HttpError(404, "Video not found");
  return result.rows[0].id as string;
}
