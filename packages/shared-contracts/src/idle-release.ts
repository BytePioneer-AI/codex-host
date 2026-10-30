import { z } from "zod";

export const IDLE_RELEASE_SETTINGS_METHOD = "codexhost/settings/idle-release/set";
export const IDLE_RELEASE_TIMEOUT_MINUTES_MIN = 5;
export const IDLE_RELEASE_TIMEOUT_MINUTES_MAX = 1440;
export const idleReleaseSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  timeoutMinutes: z
    .number()
    .int()
    .min(IDLE_RELEASE_TIMEOUT_MINUTES_MIN)
    .max(IDLE_RELEASE_TIMEOUT_MINUTES_MAX),
});
export type IdleReleaseSettings = z.infer<typeof idleReleaseSettingsSchema>;
export const DEFAULT_IDLE_RELEASE_SETTINGS: Readonly<IdleReleaseSettings> = Object.freeze({
  enabled: false,
  timeoutMinutes: 30,
});
