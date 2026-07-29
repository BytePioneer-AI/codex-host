import { z } from "zod";

import { codexhostErrorSchema } from "./errors.js";
import { hostThreadIdSchema } from "./ids.js";

export const HARNESS_MODEL_REF_MAX_LENGTH = 512;

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be empty or whitespace",
});

export const harnessModelRefIdSchema = nonBlankTextSchema
  .max(HARNESS_MODEL_REF_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~-]+$/u, "Model Ref must use transport-safe opaque characters")
  .brand<"HarnessModelRefId">();

export const harnessModelRefSchema = z
  .object({
    id: harnessModelRefIdSchema,
  })
  .strict();

export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;

export const harnessModelSchema = z
  .object({
    ref: harnessModelRefSchema,
    label: nonBlankTextSchema.max(256),
  })
  .strict();

export type HarnessModel = z.infer<typeof harnessModelSchema>;

export const harnessModelCatalogSchema = z
  .object({
    models: z.array(harnessModelSchema),
    defaultModel: harnessModelRefSchema.optional(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const refs = new Set<string>();
    for (const [index, model] of catalog.models.entries()) {
      if (refs.has(model.ref.id)) {
        context.addIssue({
          code: "custom",
          message: "Model Catalog refs must be unique",
          path: ["models", index, "ref", "id"],
        });
      }
      refs.add(model.ref.id);
    }
    if (catalog.defaultModel && !refs.has(catalog.defaultModel.id)) {
      context.addIssue({
        code: "custom",
        message: "Default Model must exist in the Model Catalog",
        path: ["defaultModel", "id"],
      });
    }
  });

export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogSchema>;

export const harnessSessionCapabilitiesSchema = z
  .object({
    configuration: z
      .object({
        selectModel: z.boolean(),
      })
      .strict(),
    history: z
      .object({
        fork: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type HarnessSessionCapabilities = z.infer<typeof harnessSessionCapabilitiesSchema>;

export const harnessModelSelectionStateSchema = z
  .object({
    effectiveModel: harnessModelRefSchema.optional(),
  })
  .strict();

export type HarnessModelSelectionState = z.infer<typeof harnessModelSelectionStateSchema>;

const readyHarnessInspectionSchema = z
  .object({
    status: z.literal("ready"),
    catalog: harnessModelCatalogSchema,
    capabilities: harnessSessionCapabilitiesSchema,
  })
  .strict();

const failedHarnessInspectionSchema = z
  .object({
    status: z.enum(["notInstalled", "unavailable", "error"]),
    error: codexhostErrorSchema,
  })
  .strict();

export const harnessInspectionSchema = z.discriminatedUnion("status", [
  readyHarnessInspectionSchema,
  failedHarnessInspectionSchema,
]);

export type HarnessInspection = z.infer<typeof harnessInspectionSchema>;

export const piHarnessInspectParamsSchema = z
  .object({
    harnessId: z.literal("pi"),
    cwd: nonBlankTextSchema.max(16_384).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export type PiHarnessInspectParams = z.infer<typeof piHarnessInspectParamsSchema>;

export const threadModelSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    model: harnessModelRefSchema,
  })
  .strict();

export type ThreadModelSelectParams = z.infer<typeof threadModelSelectParamsSchema>;

export const threadInspectionParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
  })
  .strict();

export type ThreadInspectionParams = z.infer<typeof threadInspectionParamsSchema>;

const codexThreadInspectionSchema = z
  .object({
    owner: z.literal("codex"),
    locked: z.literal(true),
  })
  .strict();

const externalThreadInspectionSchema = z
  .object({
    owner: z.literal("external"),
    harnessId: nonBlankTextSchema.max(256),
    transportModelId: nonBlankTextSchema.max(1_024),
    effectiveModel: harnessModelRefSchema.optional(),
    locked: z.literal(true),
  })
  .strict();

export const threadInspectionSchema = z.discriminatedUnion("owner", [
  codexThreadInspectionSchema,
  externalThreadInspectionSchema,
]);

export type ThreadInspection = z.infer<typeof threadInspectionSchema>;
