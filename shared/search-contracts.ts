import type { SearchHit } from "./contracts";

export type SearchResponse = { results: SearchHit[]; semanticError: string | null };
export type SearchCitation = SearchHit & { quote: string };
export type SearchAnswer = (
  | { status: "answered"; statements: { text: string; citations: SearchCitation[] }[]; provider: { model: string; requestId: string | null } }
  | { status: "insufficient_evidence"; message: string }
) & { retrievalWarning: string | null };
