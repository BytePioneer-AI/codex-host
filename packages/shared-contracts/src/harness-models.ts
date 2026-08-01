import { z } from "zod";

import { codexhostErrorSchema } from "./errors.js";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";

export const HARNESS_MODEL_REF_MAX_LENGTH = 512;
export const THREAD_OWNERSHIP_LIST_MAX_LENGTH = 100;

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
        forkAcrossCwd: z.boolean(),
      })
      .strict()
      .refine((history) => history.fork || !history.forkAcrossCwd, {
        path: ["forkAcrossCwd"],
        message: "Cross-cwd Fork requires exact history Fork support",
      }),
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

export const harnessInspectParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    cwd: nonBlankTextSchema.max(16_384).optional(),
    refresh: z.boolean().optional(),
  })
  .strict();

export type HarnessInspectParams = z.infer<typeof harnessInspectParamsSchema>;

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

export const threadOwnershipListParamsSchema = z
  .object({
    threadIds: z.array(hostThreadIdSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threadIds }, context) => {
    const seen = new Set<string>();
    for (const [index, threadId] of threadIds.entries()) {
      if (seen.has(threadId)) {
        context.addIssue({
          code: "custom",
          message: "Thread ownership-list IDs must be unique",
          path: ["threadIds", index],
        });
      }
      seen.add(threadId);
    }
  });

export type ThreadOwnershipListParams = z.infer<typeof threadOwnershipListParamsSchema>;

const codexThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("codex"),
  })
  .strict();

const externalThreadOwnershipSchema = z
  .object({
    threadId: hostThreadIdSchema,
    owner: z.literal("external"),
    harnessId: z.string().max(256).pipe(harnessIdSchema),
  })
  .strict();

export const threadOwnershipSchema = z.discriminatedUnion("owner", [
  codexThreadOwnershipSchema,
  externalThreadOwnershipSchema,
]);

export type ThreadOwnership = z.infer<typeof threadOwnershipSchema>;

export const threadOwnershipListResultSchema = z
  .object({
    threads: z.array(threadOwnershipSchema).min(1).max(THREAD_OWNERSHIP_LIST_MAX_LENGTH),
  })
  .strict()
  .superRefine(({ threads }, context) => {
    const seen = new Set<string>();
    for (const [index, thread] of threads.entries()) {
      if (seen.has(thread.threadId)) {
        context.addIssue({
          code: "custom",
          message: "Thread ownership-list results must be unique",
          path: ["threads", index, "threadId"],
        });
      }
      seen.add(thread.threadId);
    }
  });

export type ThreadOwnershipListResult = z.infer<typeof threadOwnershipListResultSchema>;
