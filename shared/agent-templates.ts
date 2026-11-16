export const agentTemplateIds = ["weekly_team", "customer_release", "coding_recap", "pull_request", "docs_walkthrough", "design_comparison", "marketing_recap"] as const;
export type AgentTemplate = typeof agentTemplateIds[number];
export const agentTemplates = {
  weekly_team: {label:"Weekly team roundup",description:"Released work and clearly labeled work in progress.",goal:"Recap the team's released work and work in progress from the past seven days.",briefHint:"Optional focus for this update.",requiresBrief:false,minimumChapters:1},
  customer_release: {label:"Customer release update",description:"Published releases in a private draft for review.",goal:"Explain published releases for customers. Keep the result a private reviewable draft.",briefHint:"Optional customer context. Do not include private implementation details.",requiresBrief:false,minimumChapters:1},
  coding_recap: {label:"Coding-agent recap",description:"What shipped, what is in progress, and what is blocked.",goal:"Explain the recorded work. Call work shipped only when supported by a published release. Name observed failures as blocked work.",briefHint:"Name the work and any known blockers. The recording checks the connected app.",requiresBrief:true,minimumChapters:1},
  pull_request: {label:"PR walkthrough",description:"The change, supported architecture, and concerns for review.",goal:"Walk through source changes and the recorded behavior. Label owner-provided architecture and review concerns as context, not inspected facts.",briefHint:"Supply the PR source link, change, architecture context, and review concerns. Connect the repository and add demo actions for that work.",requiresBrief:true,minimumChapters:1},
  docs_walkthrough: {label:"Docs walkthrough",description:"Guide someone to an answer in your connected app's docs.",goal:"Use the approved app's documentation controls to reach the answer in the owner's brief. Do not follow external links or claim unread documentation was inspected.",briefHint:"Supply the question and the docs route. The checked-in demo must open that route inside the connected app.",requiresBrief:true,minimumChapters:1},
  design_comparison: {label:"Design comparison",description:"Record two options and explain the supplied tradeoffs.",goal:"Compare the actual recorded options. Attribute supplied tradeoffs to the owner. Do not describe an option that was not recorded.",briefHint:"Identify both connected app snapshots and their tradeoffs. At least two approved scenes must be available.",requiresBrief:true,minimumChapters:2},
  marketing_recap: {label:"Marketing recap",description:"Explain supplied results, their sources, and what remains unknown.",goal:"Read supplied marketing evidence as owner-provided context. Preserve its units, period, and sources. Never invent metrics or claim a metrics service was inspected.",briefHint:"Supply the actual metrics, units, period, source links, and unknowns. No marketing service is connected automatically.",requiresBrief:true,minimumChapters:1},
} satisfies Record<AgentTemplate,{label:string;description:string;goal:string;briefHint:string;requiresBrief:boolean;minimumChapters:number}>;

export type DemoPresentation = {
  template: AgentTemplate;
  recipient: string;
  brief: string;
  narration: {kind:"default"} | {kind:"personal";name:string};
};
export type VoiceProfile = {
  id:string; name:string; status:"creating"|"ready"|"verification_required"|"uncertain"|"failed"|"deleting"|"delete_failed";
  error:string|null; createdAt:string;
};
export type VoiceSetup = {profile:VoiceProfile|null;configured:boolean};
export const voiceConsentVersion = "personal-voice-v1";
export const recordingRetryNotice = "Retry records the demo and generates narration again. Provider charges may apply.";
