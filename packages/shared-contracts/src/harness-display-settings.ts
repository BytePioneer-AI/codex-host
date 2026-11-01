import { z } from "zod";

export const HARNESS_DISPLAY_GET_METHOD = "codexhost/harness/display-settings/get";
export const HARNESS_DISPLAY_SET_METHOD = "codexhost/harness/display-settings/set";

/** Machine-local presentation only; never changes Harness availability or enablement. */
export const harnessDisplayEntriesSchema = z
  .array(
    z.strictObject({
      agent: z.string().min(1).max(128),
      section: z.enum(["main", "more", "auto"]),
    }),
  )
  .max(256)
  .refine(
    (entries) => new Set(entries.map((entry) => entry.agent)).size === entries.length,
    "Duplicate Harness IDs",
  );
export const harnessDisplaySettingsSchema = z.strictObject({
  entries: harnessDisplayEntriesSchema.nullable(),
});
export const harnessDisplayGetSchema = z.strictObject({});
export const harnessDisplaySetSchema = z.strictObject({
  entries: harnessDisplayEntriesSchema,
  /** Import legacy Desktop preferences only if no shared settings exist yet. */
  initializeOnly: z.boolean().optional(),
});
export type HarnessDisplayEntries = z.infer<typeof harnessDisplayEntriesSchema>;
export type HarnessDisplaySettings = z.infer<typeof harnessDisplaySettingsSchema>;
export type HarnessDisplaySet = z.infer<typeof harnessDisplaySetSchema>;
