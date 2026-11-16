export type VideoChapter = { title: string; startMs: number; endMs: number };

export function readVideoChapters(value: unknown, durationMs: number): VideoChapter[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12 || !Number.isSafeInteger(durationMs) || durationMs <= 0) return [];
  const chapters: VideoChapter[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Object.keys(item).length !== 3) return [];
    const { title, startMs, endMs } = item as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || title.length > 120 || typeof startMs !== "number" || typeof endMs !== "number" || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs) return [];
    if (chapters.length && chapters[chapters.length - 1].endMs !== startMs) return [];
    chapters.push({ title, startMs, endMs });
  }
  return chapters;
}
