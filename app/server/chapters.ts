import { z } from "zod";
import { readVideoChapters } from "../../shared/video-chapters";
import type { Sql } from "./runtime";

export const chapterStartsSchema = z.array(z.object({ startMs: z.number().int().nonnegative(), title: z.string().trim().min(1).max(120), quote: z.string().min(1).max(1000).refine(value => value.trim().length > 0) }).strict()).max(12);

export function validateChapterStarts(value: unknown, evidence: { positionMs: number; text: string }[], durationMs: number) {
  const chapters = chapterStartsSchema.parse(value);
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    const chunk = evidence.find(item => item.positionMs === chapter.startMs);
    if (chapter.startMs >= durationMs || index > 0 && chapter.startMs <= chapters[index - 1].startMs || !chunk || !(` ${chunk.text} `).includes(` ${chapter.quote} `)) throw new Error("Chapter boundaries or quotes did not match the complete transcript. Retry processing");
  }
  return chapters.length < 2 ? [] : chapters;
}

export function chaptersJson(value: unknown, durationMs: number, complete: boolean) {
  if (!complete) return [];
  const parsed = chapterStartsSchema.safeParse(value);
  if (!parsed.success) return [];
  return readVideoChapters(parsed.data.map(({ title, startMs }, index) => ({ title, startMs, endMs: parsed.data[index + 1]?.startMs ?? durationMs })), durationMs);
}

export function publishChapters(db: Sql, video: { id: string; transcript_hash: string; duration_ms: number }, chapters: z.infer<typeof chapterStartsSchema>) {
  return db.query("UPDATE videos SET chapters=$2 WHERE id=$1 AND transcript_hash=$3 AND duration_ms=$4 AND transcription_complete=true AND deleted_at IS NULL AND (jsonb_array_length($2::jsonb)>=2 OR chapters IS NULL OR jsonb_array_length(chapters)<2)", [video.id, JSON.stringify(chapters), video.transcript_hash, video.duration_ms]);
}
