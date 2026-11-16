import { z } from "zod";

export type SharedNoteSegment = {
  id: string;
  channel: "microphone" | "system";
  text: string;
  startMs: number;
  endMs: number;
};

export type SharedMeetingNoteInput = {
  clientMeetingId: string;
  teamId: string | null;
  folderId: string | null;
  title: string;
  notesText: string;
  summary: string | null;
  transcript: SharedNoteSegment[];
  sourceRevision: number;
  sourceCreatedAt: string;
  expectedVersion: number | null;
};

export type SharedMeetingNote = Omit<SharedMeetingNoteInput, "expectedVersion"> & {
  id: string;
  ownerId: string;
  ownerName: string;
  teamName: string | null;
  folderName: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export const SHARED_MEETING_NOTE_MAX_BYTES = 900_000;
export const SHARED_MEETING_NOTE_OWNER_NAME_MAX_CHARS = 500;
const sourceText=()=>z.string().refine(value=>!value.includes('\u0000')&&!/[\uD800-\uDFFF]/u.test(value),"Remove NUL or incomplete Unicode characters before sharing. Your original local note is unchanged.");
export const sharedNoteSegmentSchema = z.strictObject({
  id: sourceText().min(1).max(240), channel: z.enum(["microphone", "system"]), text: sourceText().max(900_000),
  startMs: z.number().int().nonnegative().max(86_400_000), endMs: z.number().int().nonnegative().max(86_400_000),
}).refine(segment => segment.endMs >= segment.startMs, "Transcript end must not precede its start");
export const sharedMeetingNoteInputSchema = z.strictObject({
  clientMeetingId: z.uuid(), teamId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).nullable(),
  folderId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/).nullable(),
  title: sourceText().trim().min(1).max(240), notesText: sourceText().max(900_000), summary: sourceText().max(900_000).nullable(),
  transcript: z.array(sharedNoteSegmentSchema).max(10_000).refine(segments => new Set(segments.map(segment => segment.id)).size === segments.length, "Transcript segment IDs must be unique"),
  sourceRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sourceCreatedAt: z.iso.datetime({offset: true}),
  expectedVersion: z.number().int().positive().max(2_147_483_647).nullable(),
});
const serverFields = {
  id: z.uuid(), ownerId: z.string().min(1).max(240), ownerName: z.string().max(SHARED_MEETING_NOTE_OWNER_NAME_MAX_CHARS), teamName: z.string().max(120).nullable(), folderName: z.string().max(120).nullable(),
  version: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
};
export const sharedMeetingNoteSchema = sharedMeetingNoteInputSchema.omit({expectedVersion: true}).extend(serverFields);
export const sharedMeetingNoteListItemSchema = sharedMeetingNoteSchema.omit({notesText: true, summary: true, transcript: true}).extend({
  notesPreview: z.string().refine(value => Array.from(value).length <= 400, "Notes preview exceeds 400 Unicode characters"),
  summaryPreview: z.string().refine(value => Array.from(value).length <= 600, "Summary preview exceeds 600 Unicode characters").nullable(),
  transcriptSegmentCount: z.number().int().nonnegative(),
});


export type SharedMeetingNoteListItem = Omit<SharedMeetingNote, "notesText" | "summary" | "transcript"> & {
  notesPreview: string;
  summaryPreview: string | null;
  transcriptSegmentCount: number;
};
