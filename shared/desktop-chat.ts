import { z } from 'zod';

export const chatScopeSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('all')}),z.strictObject({kind:z.literal('meeting'),id:z.string().uuid()}),
  z.strictObject({kind:z.literal('video'),id:z.string().regex(/^[a-zA-Z0-9_-]{1,240}$/)}),
  z.strictObject({kind:z.literal('team-note'),id:z.uuid()})
]);
export type ChatScope = { kind: 'all' } | { kind: 'meeting'; id: string } | { kind: 'video'; id: string } | { kind: 'team-note'; id: string };
export type ChatCitation = {
  sourceRef: string; title: string; source: 'notes' | 'transcript' | 'title' | 'comment' | 'speech' | 'visual';
  positionMs: number | null; url: string; quote: string;
} & ({ kind: 'meeting'; meetingId: string; segmentId: string | null } | { kind: 'video'; videoId: string } | { kind: 'team-note'; noteId: string; segmentId: string | null });
export type ChatStatement = { text: string; citations: ChatCitation[] };
export type ChatTurn = {
  requestId: string; question: string; status: 'generating' | 'answered' | 'insufficient_evidence' | 'unverified' | 'error' | 'cancelled';
  statements: ChatStatement[]; error: string | null; coverage: string; createdAt: string; updatedAt: string;
};
export type ChatThreadSummary = { id: string; title: string; scope: ChatScope; localOnly: boolean; createdAt: string; updatedAt: string };
export type ChatThread = ChatThreadSummary & { turns: ChatTurn[] };
export type ChatRequest =
  | { method: 'chat.list' }
  | { method: 'chat.get'; id: string }
  | { method: 'chat.delete'; id: string }
  | { method: 'chat.create'; scope: ChatScope }
  | { method: 'chat.ask'; id: string; requestId: string; question: string }
  | { method: 'chat.cancel'; id: string; requestId: string };
export type NativeChatResult = {
  status: 'answered' | 'insufficient_evidence';
  statements: { text: string; sourceRef: string; quote: string }[];
  model: 'apple-on-device';
};
