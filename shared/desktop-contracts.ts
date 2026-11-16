import type { Bootstrap, User, Word } from "./contracts";
import type { ChatRequest } from "./desktop-chat";
import type { CalendarState } from "./desktop-calendar";
import type { DesktopSettings, SettingsAction, SettingsChange } from "./desktop-settings";

export type MeetingPolicy = { processing: "local" | "cloud"; sync: "off" | "workspace"; sharing: "private" | "detected" | "invitees" };
export type MeetingPhase = "idle" | "recording" | "transcribing" | "ready" | "interrupted" | "error";
export type MeetingSegment = { id: string; channel: "microphone" | "system"; text: string; startMs: number; endMs: number; words: Word[] };
export type MeetingSummary = { status: "idle" | "generating" | "ready" | "error"; text: string | null; error: string | null; sourceHash: string | null; updatedAt: string | null; stale: boolean };
export type SummaryAvailability = { available: boolean; reason: string | null };
export type Meeting = {
  id: string; title: string; notes: string; revision: number; createdAt: string; updatedAt: string;
  policy: MeetingPolicy; phase: MeetingPhase; segments: MeetingSegment[]; summary: MeetingSummary; error: string | null; hasAudio: boolean; playbackUrl?: string | null; playbackWarning?: string | null;
};
export type MeetingListItem = Omit<Meeting, "notes" | "segments"> & { preview: string };
export type SpeechState = { status: "missing" | "downloading" | "loading" | "ready" | "error"; downloadedBytes: number; totalBytes: number; error: string | null };
export type CaptureState = { kind: "idle" } | { kind: "meeting"; meetingId: string; phase: "recording" | "transcribing" } | { kind: "dictation"; phase: "recording" | "transcribing" };
export type WorkspaceConnection = { origin: string | null; user: User | null; bootstrap: Bootstrap | null; error: string | null };
export type DesktopSnapshot = {
  calendar: CalendarState; meetings: MeetingListItem[]; speech: SpeechState; summary: SummaryAvailability; capture: CaptureState; workspace: WorkspaceConnection;
  nativeAvailable: boolean; nativeError: string | null;
  capabilities: { cloudProcessing: boolean; workspaceSync: boolean; calendar: boolean; recipientDelivery: boolean };
};
export type DesktopEvent =
  | { type: "state"; snapshot: DesktopSnapshot }
  | { type: "meeting"; meeting: Meeting }
  | { type: "navigate"; path: string }
  | { type: "dictation"; text: string; inserted: boolean; error: string | null }
  | { type: "settings"; settings: DesktopSettings };

export type DesktopRequest = ChatRequest
  | { method: "calendar.refresh" }
  | { method: "calendar.connect" }
  | { method: "state" }
  | { method: "meeting.create"; title?: string }
  | { method: "meeting.get"; id: string }
  | { method: "meeting.update"; id: string; revision: number; title?: string; notes?: string; policy?: MeetingPolicy }
  | { method: "meeting.trash"; id: string }
  | { method: "meeting.start"; id: string; systemAudio: boolean }
  | { method: "meeting.stop" }
  | { method: "meeting.import"; id: string }
  | { method: "meeting.retry"; id: string }
  | { method: "meeting.summarize"; id: string }
  | { method: "meeting.publish"; id: string; teamId: string | null; folderId: string | null }
  | { method: "speech.install" }
  | { method: "dictation.start" }
  | { method: "dictation.stop" }
  | { method: "dictation.copy" }
  | { method: "workspace.connect"; origin: string; email: string; password: string }
  | { method: "workspace.disconnect" }
  | { method: "workspace.request"; path: string; verb: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE"; body?: unknown }
  | { method: "recorder.start" }
  | { method: "recorder.stop" }
  | { method: "settings.read" }
  | { method: "settings.change"; change: SettingsChange }
  | { method: "settings.action"; action: SettingsAction }
  | { method: "external.open"; url: string };

export type DesktopResponse = { ok: true; value: unknown } | { ok: false; error: string; status: number };
export interface DesktopBridge {
  invoke(request: DesktopRequest): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}

export type NativeMethod = "status" | "speech.load" | "speech.transcribe" | "summary.status" | "summary.generate" | "meeting.start" | "meeting.stop" | "meeting.recover" | "dictation.start" | "dictation.stop" | "workspace.session" | "workspace.connect" | "workspace.disconnect" | "recorder.start" | "recorder.stop" | "settings.open" | "settings.update" | "settings.read" | "settings.change" | "settings.action" | "settings.shortcut" | "calendar.status" | "calendar.connect" | "calendar.events" | "chat.answer" | "chat.cancel" | "shutdown";
export type NativeRequest = { id: string; method: NativeMethod; params: Record<string, unknown> };
export type NativeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
export type NativeEvent = { event: "ready" | "capture" | "segment" | "dictation" | "workspace" | "navigate" | "error" | "speech.installRequested"; payload: Record<string, unknown> };
export type NativeSession = { origin: string; token: string; user: User };
