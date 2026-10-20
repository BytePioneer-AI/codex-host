import { z } from "zod";

export const VOICE_SETTINGS_METHOD = "codexhost/voice/settings";
export const VOICE_GATEWAY_STATUS_METHOD = "codexhost/voice/gateway-status";
export const voiceRoutesSchema = z.strictObject({
  chatExperience: z.enum(["chatgpt", "codex"]),
  chatConnection: z.enum(["desktop", "gateway"]),
  workConnection: z.enum(["desktop", "gateway"]),
});
export type VoiceRoutes = z.infer<typeof voiceRoutesSchema>;
export const DEFAULT_VOICE_ROUTES: VoiceRoutes = Object.freeze({
  chatExperience: "chatgpt",
  chatConnection: "desktop",
  workConnection: "gateway",
});
export const voiceSettingsSchema = voiceRoutesSchema.extend({ inject: z.boolean() });
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;
export const voiceSettingsRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("get"),
    runtime: z
      .strictObject({
        id: z.string().uuid(),
        revision: z.string().max(64),
        activeCall: z.boolean(),
      })
      .optional(),
  }),
  z.strictObject({ operation: z.literal("migrate"), routes: voiceRoutesSchema }),
  z.strictObject({
    operation: z.literal("set"),
    settings: voiceSettingsSchema,
    revision: z.string().max(64),
  }),
  z.strictObject({ operation: z.literal("restart"), confirm: z.literal(true) }),
]);
export type VoiceSettingsRequest = z.infer<typeof voiceSettingsRequestSchema>;
export const voiceSettingsStateSchema = z.strictObject({
  settings: voiceSettingsSchema,
  initialized: z.boolean(),
  revision: z.string(),
  activeInject: z.boolean().nullable(),
  envOverride: z.enum(["0", "1"]).nullable(),
  activeEnvOverride: z.enum(["0", "1"]).nullable(),
  routesActive: z.boolean().nullable(),
  activeCall: z.boolean().nullable(),
  gatewayReady: z.boolean().nullable(),
  restartAvailable: z.boolean(),
  restart: z.strictObject({
    phase: z.enum(["idle", "restarting", "succeeded", "failed"]),
    error: z.string().nullable(),
  }),
});
export type VoiceSettingsState = z.infer<typeof voiceSettingsStateSchema>;
