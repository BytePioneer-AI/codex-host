import { z } from "zod";
import { harnessPluginIdSchema } from "./harness-plugins.js";

export const HARNESS_LAUNCH_SETTINGS_GET_METHOD = "codexhost/harness/launch-settings/get";
export const HARNESS_LAUNCH_SETTINGS_SET_METHOD = "codexhost/harness/launch-settings/set";

export const harnessConnectionModeSchema = z.enum(["auto", "desktop", "web"]);
export type HarnessConnectionMode = z.infer<typeof harnessConnectionModeSchema>;

/** An installation directory (or legacy entrypoint), never a shell command line or arguments. */
export const harnessLaunchPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\u0000\r\n]/u.test(value), "Invalid entrypoint path");
export const harnessLaunchSettingsGetSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
  })
  .strict();
export const harnessLaunchSettingsSetSchema = harnessLaunchSettingsGetSchema
  .extend({
    path: harnessLaunchPathSchema.nullable().optional(),
    connectionMode: harnessConnectionModeSchema.optional(),
  })
  .refine(
    (value) => value.path !== undefined || value.connectionMode !== undefined,
    "No launch setting supplied",
  );
export const harnessLaunchSettingsSchema = z
  .object({
    path: harnessLaunchPathSchema.nullable(),
    restartRequired: z.boolean(),
    connectionMode: harnessConnectionModeSchema.optional(),
  })
  .strict();
export type HarnessLaunchSettings = z.infer<typeof harnessLaunchSettingsSchema>;
export type HarnessLaunchSettingsGet = z.infer<typeof harnessLaunchSettingsGetSchema>;
export type HarnessLaunchSettingsSet = z.infer<typeof harnessLaunchSettingsSetSchema>;
