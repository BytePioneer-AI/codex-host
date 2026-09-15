import { z } from "zod";

export const IDLE_RELEASE_SETTINGS_METHOD = "codexhost/settings/idle-release/set";
export const idleReleaseSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  timeoutMinutes: z.number().int().min(10).max(1440),
});
export type IdleReleaseSettings = z.infer<typeof idleReleaseSettingsSchema>;
export const DEFAULT_IDLE_RELEASE_SETTINGS: Readonly<IdleReleaseSettings> = Object.freeze({
  enabled: false,
  timeoutMinutes: 30,
});
