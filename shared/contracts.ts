import type { DemoPresentation } from "./agent-templates";
import type { VideoChapter } from "./video-chapters";
export type { VideoChapter } from "./video-chapters";

export type User = { id: string; name: string; email: string };
export type AccountPlan = "free" | "workspace";
export type AccountEntitlements = { plan: AccountPlan; canOrganize: boolean };
export type ShareLink = { url: string; expiresAt: string; status: "active" | "expired" | "revoked" };
export type SharedVideo = { title: string; durationMs: number; mimeType: string; expiresAt: string; mediaUrl: string; playbackUrl: string; chapters: VideoChapter[] };
export type Team = { id: string; name: string; role: "owner" | "member" };
export type Folder = { id: string; name: string; teamId: string | null };
export type Video = {
  id: string; recordingId: string; title: string; ownerId: string; ownerName: string;
  teamId: string | null; folderId: string | null; durationMs: number; byteLength: number;
  mimeType: string; uploadState: "pending" | "uploaded"; processingStatus: string;
  aiStatus: string; createdAt: string; videoUrl: string; mediaUrl: string; agentRunId: string | null; chapters: VideoChapter[];
};
export type Comment = {
  id: string; videoId: string; parentId: string | null; body: string;
  positionMs: number; authorId: string | null; authorName: string;
  createdAt: string; updatedAt: string; deletedAt: string | null; source: "web" | "slack" | "agent" | "summary";
  summaryMoments?: Summary["moments"];
};
export type Activity = {
  id: string; kind: "view" | "comment" | "reply" | "video";
  videoId: string; videoTitle: string; actorName: string; actorImage?: string | null; body: string | null;
  positionMs: number | null; createdAt: string; videoUrl: string;
};
export type Word = { word: string; startMs: number; endMs: number };
export type Summary = { text: string; moments: { positionMs: number; text: string; quote?: string }[] };
export type FeedPost = { video: Video; comments: Comment[] };
export type VideoViewers = { items: { id: string; name: string; image: string | null }[]; total: number };
export type VideoDetail = {
  video: Video; shareLink: ShareLink | null; comments: Comment[]; words: Word[]; viewers: VideoViewers;
  processing: { status: string; error: string | null };
  slack: { connected: boolean; threadUrl: string | null; error: string | null };
  feedback: { status: string; error: string | null };
};
export type SearchHit = {
  videoId: string; videoTitle: string; source: "title" | "comment" | "speech" | "visual";
  text: string; positionMs: number | null; videoUrl: string;
};
export type Bootstrap = {
  user: User; account: AccountEntitlements; teams: Team[]; folders: Folder[];
  capabilities: { ai: string; transcription: string; slack: string; storage: "local" | "r2" };
};
export type UploadInput = {
  recordingId: string; title: string; mimeType: string; byteLength: number;
  durationMs: number; teamId?: string | null; folderId?: string | null;
};
export type UploadPreparation = {
  video: Video; videoUrl: string; completeUrl: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
};
export type UploadReceipt = {
  video: Video;
  receipt: { id: string; recordingId: string; byteLength: number; sha256: string | null; durable: true };
};
export type AgentAudience = "internal" | "customer";
export type DemoAction =
  | { kind: "click"; role: "button" | "link" | "tab" | "checkbox"; name: string }
  | { kind: "fill"; label: string; value: string }
  | { kind: "assert"; text: string };
export type DemoManifest = {
  install?: string[]; build?: string[]; start: string[]; port: number; goal: string; actions?: DemoAction[];
};
export type DemoChapter = {
  connectionId: string; repository: string; commitSha: string; state: "released" | "in_progress";
  heading: string; facts: string[]; manifest: DemoManifest; sourceUrl: string;
};
export type RepositoryConnection = {
  id: string; teamId: string; repository: string; branch: string; status: string; error: string | null;
};
export type AgentSchedule = {
  id: string; teamId: string; audience: AgentAudience; weekday: number; minute: number;
  timeZone: string; nextRunAt: string; enabled: boolean;
};
export type AgentRun = {
  id: string; teamId: string; audience: AgentAudience; kind: string; title: string; status: string;
  videoId: string | null; error: string | null; createdAt: string; result: Record<string, unknown> | null;
  presentation?: DemoPresentation;
};
export type AgentWorkspace = {
  connections: RepositoryConnection[]; schedules: AgentSchedule[]; runs: AgentRun[];
  feedback: FeedbackReview[];
  setup: { runner: boolean; ai: boolean; webhookOrigin: string };
};
export type FeedbackReview = {
  video: Video; status: string | null; error: string | null; updatedAt: string | null;
  transcriptionComplete: boolean; comments: Comment[];
};

export type ApiSeed<T> = { path: string; data: T | null; error: string };
export type LibraryData = { posts: FeedPost[] } | { videos: Video[] };
export type PageData = { kind: "auth"; mode: "signup" | "signin" } | { kind: "workspace"; bootstrap: Bootstrap; serverOrigin: string; library?: ApiSeed<LibraryData> | null };
