import { z } from "zod";
import { idleReleaseSettingsSchema } from "./idle-release.js";
import { harnessModelRefSchema, harnessThinkingOptionIdSchema } from "./harness-models.js";
import { harnessPermissionModeIdSchema } from "./harness-permission-modes.js";
import { installedHarnessPluginIdSchema } from "./harness-plugins.js";

export const HARNESS_PREFERENCES_GET_METHOD = "codexhost/harness/preferences/get";
export const HARNESS_PREFERENCES_PATCH_METHOD = "codexhost/harness/preferences/patch";
export const HARNESS_PREFERENCES_CHANGED_METHOD = "codexhost/harness/preferences/changed";
export const harnessPreferenceScopeSchema = z.string().regex(/^external$/u);
const preferenceHarnessKey = installedHarnessPluginIdSchema.transform((id) => String(id));
export const harnessDefaultConfigurationSchema = z
  .strictObject({
    model: harnessModelRefSchema.optional(),
    thinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    permissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .refine(
    (value) => Boolean(value.model || value.thinkingOptionId || value.permissionModeId),
    "A default configuration must contain a preference",
  );
export const newThreadDefaultsSchema = z.strictObject({
  lastHarness: installedHarnessPluginIdSchema.optional(),
  byHarness: z.record(preferenceHarnessKey, harnessDefaultConfigurationSchema),
});
const modelId = z.string().min(1).max(1024);
export const harnessPreferenceValuesSchema = z.strictObject({
  idleRelease: idleReleaseSettingsSchema.optional(),
  favorites: z.record(preferenceHarnessKey, z.array(modelId).max(2048)).default({}),
  newThread: newThreadDefaultsSchema.optional(),
});
export const harnessPreferenceSnapshotSchema = z.strictObject({
  scope: harnessPreferenceScopeSchema,
  revision: z.number().int().nonnegative(),
  values: harnessPreferenceValuesSchema,
});
export const harnessPreferenceGetSchema = z.strictObject({
  scope: harnessPreferenceScopeSchema.default("external"),
});
export const harnessPreferenceOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("idleRelease"), value: idleReleaseSettingsSchema }),
  z.strictObject({
    kind: z.literal("favorite"),
    harnessId: installedHarnessPluginIdSchema,
    modelId,
    enabled: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("favorites"),
    harnessId: installedHarnessPluginIdSchema,
    modelIds: z.array(modelId).max(2048),
  }),
  z.strictObject({
    kind: z.literal("newThread"),
    lastHarness: installedHarnessPluginIdSchema.optional(),
    harnessId: installedHarnessPluginIdSchema.optional(),
    configuration: harnessDefaultConfigurationSchema.optional(),
  }),
]);
export const harnessPreferencePatchSchema = z
  .strictObject({
    scope: harnessPreferenceScopeSchema.default("external"),
    operations: z.array(harnessPreferenceOperationSchema).min(1).max(256),
    initializeOnly: z.boolean().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .superRefine((input, ctx) => {
    for (const operation of input.operations) {
      if (
        operation.kind === "newThread" &&
        ((!operation.lastHarness && !operation.configuration) ||
          Boolean(operation.harnessId) !== Boolean(operation.configuration))
      )
        ctx.addIssue({
          code: "custom",
          message: "A default Harness or complete configuration is required",
        });
      const harnessId = "harnessId" in operation ? operation.harnessId : undefined;
      if (harnessId === "codex")
        ctx.addIssue({
          code: "custom",
          message: "Official Codex is not an external Harness",
        });
    }
  });
export const harnessPreferencesDocumentSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  scopes: z.record(harnessPreferenceScopeSchema, harnessPreferenceValuesSchema),
});
export type HarnessPreferenceScope = z.infer<typeof harnessPreferenceScopeSchema>;
export type HarnessPreferenceSnapshot = z.infer<typeof harnessPreferenceSnapshotSchema>;
export type HarnessPreferencePatch = z.infer<typeof harnessPreferencePatchSchema>;
export type HarnessPreferenceOperation = z.infer<typeof harnessPreferenceOperationSchema>;
export type HarnessPreferenceValues = z.infer<typeof harnessPreferenceValuesSchema>;
