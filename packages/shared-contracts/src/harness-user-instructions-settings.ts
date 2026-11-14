import { z } from "zod";
import { harnessPluginIdSchema } from "./harness-plugins.js";

export const HARNESS_USER_INSTRUCTIONS_SETTINGS_GET_METHOD =
  "codexhost/harness/user-instructions-settings/get";
export const HARNESS_USER_INSTRUCTIONS_SETTINGS_SET_METHOD =
  "codexhost/harness/user-instructions-settings/set";

export const harnessUserInstructionsDisabledListSchema = z
  .array(harnessPluginIdSchema)
  .max(64)
  .refine((items) => new Set(items).size === items.length, "Duplicate Harness IDs");

export const harnessUserInstructionsGetSchema = z.strictObject({});

export const harnessUserInstructionsSetSchema = z.strictObject({
  enabled: z.boolean(),
  disabledHarnesses: harnessUserInstructionsDisabledListSchema.optional(),
});

export const harnessUserInstructionsEntrySchema = z.strictObject({
  harnessId: harnessPluginIdSchema,
  enabled: z.boolean(),
  targetPath: z.string().min(1).max(512),
});

export const harnessUserInstructionsSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  sourcePath: z.string().min(1).max(512),
  harnesses: z
    .array(harnessUserInstructionsEntrySchema)
    .max(64)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.harnessId)).size === entries.length,
      "Duplicate Harness IDs",
    ),
});

export type HarnessUserInstructionsGet = z.infer<typeof harnessUserInstructionsGetSchema>;
export type HarnessUserInstructionsSet = z.infer<typeof harnessUserInstructionsSetSchema>;
export type HarnessUserInstructionsEntry = z.infer<typeof harnessUserInstructionsEntrySchema>;
export type HarnessUserInstructionsSettings = z.infer<typeof harnessUserInstructionsSettingsSchema>;
