import { z } from "zod";

export const settingsSectionSchema = z.enum(["general", "speech", "account", "shortcuts"]);
export type SettingsSection = z.infer<typeof settingsSectionSchema>;
export const shortcutTargetSchema = z.enum(["start", "stop", "dictation"]);
export type ShortcutTarget = z.infer<typeof shortcutTargetSchema>;
const message = z.string().max(8000).nullable();
export const desktopSettingsSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unavailable"), reason: z.string().min(1).max(8000) }),
  z.strictObject({
    status: z.literal("ready"), message,
    general: z.strictObject({ launchAtLogin: z.enum(["not-registered", "enabled", "requires-approval", "not-found", "unknown"]), notificationsEnabled: z.boolean(), notificationPermission: z.string().max(1000), accessibilityAllowed: z.boolean(), systemAudio: z.boolean(), microphone: z.boolean(), captureBusy: z.boolean() }),
    account: z.strictObject({ serverOrigin: z.string().max(2048), canChange: z.boolean(), connecting: z.boolean(), restoring: z.boolean(), error: message }),
    shortcuts: z.strictObject({ start: z.string().max(240), stop: z.string().max(240), dictation: z.string().max(240), capturing: shortcutTargetSchema.nullable(), error: message }),
    recovery: z.strictObject({ available: z.boolean(), records: z.array(z.strictObject({ id: z.string().uuid(), title: z.string().max(4000), phase: z.enum(["recording", "processing", "ready", "uploading", "failed", "uploaded"]), error: message, uploading: z.boolean(), canRetry: z.boolean() })).max(10_000), issues: z.array(z.string().max(8000)).max(10_000) }),
  }),
]);
export type DesktopSettings = z.infer<typeof desktopSettingsSchema>;
export type ReadyDesktopSettings = Extract<DesktopSettings, { status: "ready" }>;
export const settingsChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("launch-at-login"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("notifications"), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("audio"), systemAudio: z.boolean(), microphone: z.boolean() }),
  z.strictObject({ kind: z.literal("server"), origin: z.string().min(1).max(2048) }),
]);
export type SettingsChange = z.infer<typeof settingsChangeSchema>;
export const settingsActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["open-login-items", "request-accessibility", "open-recordings", "shortcut-cancel"]) }),
  z.strictObject({ kind: z.literal("shortcut-begin"), target: shortcutTargetSchema }),
  z.strictObject({ kind: z.enum(["reveal-recording", "retry-recording"]), id: z.string().uuid() }),
]);
export type SettingsAction = z.infer<typeof settingsActionSchema>;
