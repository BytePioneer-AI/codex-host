import { z } from "zod";

import { codexhostErrorSchema } from "./errors.js";
import {
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "./harness-permission-modes.js";
import { harnessIdSchema, hostThreadIdSchema } from "./ids.js";
import { threadUsageSnapshotSchema } from "./thread-usage.js";

export const HARNESS_MODEL_REF_MAX_LENGTH = 512;
export const HARNESS_MODEL_LABEL_MAX_LENGTH = 256;
export const HARNESS_THINKING_OPTION_ID_MAX_LENGTH = 128;
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

export const harnessThinkingOptionIdSchema = nonBlankTextSchema
  .max(HARNESS_THINKING_OPTION_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._~-]+$/u, "Thinking option ID must use transport-safe characters")
  .brand<"HarnessThinkingOptionId">();

export type HarnessThinkingOptionId = z.infer<typeof harnessThinkingOptionIdSchema>;

export const harnessResolvedModelLabelSchema = nonBlankTextSchema.max(
  HARNESS_MODEL_LABEL_MAX_LENGTH,
);

export const harnessThinkingOptionSchema = z
  .object({
    id: harnessThinkingOptionIdSchema,
    label: nonBlankTextSchema.max(HARNESS_MODEL_LABEL_MAX_LENGTH),
  })
  .strict();

export type HarnessThinkingOption = z.infer<typeof harnessThinkingOptionSchema>;

export const harnessModelSchema = z
  .object({
    ref: harnessModelRefSchema,
    label: nonBlankTextSchema.max(HARNESS_MODEL_LABEL_MAX_LENGTH),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    supportedThinkingOptionIds: z.array(harnessThinkingOptionIdSchema).optional(),
  })
  .strict();

export type HarnessModel = z.infer<typeof harnessModelSchema>;

const harnessThinkingOptionsSchema = z
  .array(harnessThinkingOptionSchema)
  .superRefine((options, context) => {
    const ids = new Set<string>();
    for (const [index, option] of options.entries()) {
      if (ids.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: "Thinking option IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(option.id);
    }
  });

export const harnessModelCatalogSchema = z
  .object({
    models: z.array(harnessModelSchema),
    defaultModel: harnessModelRefSchema.optional(),
    thinkingOptions: harnessThinkingOptionsSchema,
    defaultThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const refs = new Set<string>();
    const thinkingIds = new Set(catalog.thinkingOptions.map(({ id }) => id));
    for (const [index, model] of catalog.models.entries()) {
      if (refs.has(model.ref.id)) {
        context.addIssue({
          code: "custom",
          message: "Model Catalog refs must be unique",
          path: ["models", index, "ref", "id"],
        });
      }
      refs.add(model.ref.id);
      const supportedThinkingIds = new Set<string>();
      for (const [optionIndex, optionId] of (model.supportedThinkingOptionIds ?? []).entries()) {
        if (supportedThinkingIds.has(optionId)) {
          context.addIssue({
            code: "custom",
            message: "Supported Thinking option IDs must be unique per Model",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
        supportedThinkingIds.add(optionId);
        if (!thinkingIds.has(optionId)) {
          context.addIssue({
            code: "custom",
            message: "Supported Thinking option must exist in the catalog",
            path: ["models", index, "supportedThinkingOptionIds", optionIndex],
          });
        }
      }
    }
    if (catalog.defaultModel && !refs.has(catalog.defaultModel.id)) {
      context.addIssue({
        code: "custom",
        message: "Default Model must exist in the Model Catalog",
        path: ["defaultModel", "id"],
      });
    }
    if (catalog.defaultThinkingOptionId && !thinkingIds.has(catalog.defaultThinkingOptionId)) {
      context.addIssue({
        code: "custom",
        message: "Default Thinking option must exist in the catalog",
        path: ["defaultThinkingOptionId"],
      });
    }
  });

export type HarnessModelCatalog = z.infer<typeof harnessModelCatalogSchema>;

const harnessHistoryCapabilitiesSchema = z
  .object({
    fork: z.boolean(),
    forkAcrossCwd: z.boolean(),
    rollbackLastTurn: z.boolean(),
    replacementFence: z.boolean().optional(),
  })
  .strict()
  .refine((history) => history.fork || !history.forkAcrossCwd, {
    path: ["forkAcrossCwd"],
    message: "Cross-cwd Fork requires exact history Fork support",
  })
  .refine((history) => !history.rollbackLastTurn || history.replacementFence === true, {
    path: ["replacementFence"],
    message: "Last-Turn rollback requires a history replacement fence",
  });

export const harnessPermissionModeScopeSchema = z.enum(["live", "atCreate"]);

export type HarnessPermissionModeScope = z.infer<typeof harnessPermissionModeScopeSchema>;

export function permissionModeFixedAtCreate(configuration: {
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return configuration.permissionModeScope === "atCreate";
}

export const harnessSessionCapabilitiesSchema = z
  .object({
    configuration: z
      .object({
        selectModel: z.boolean(),
        selectThinkingOption: z.boolean(),
        selectPermissionMode: z.boolean(),
        permissionModeScope: harnessPermissionModeScopeSchema.default("live"),
      })
      .strict(),
    history: harnessHistoryCapabilitiesSchema,
    subagents: z
      .object({
        observe: z.boolean(),
        readTranscript: z.boolean(),
      })
      .strict()
      .optional(),
    autonomousTurns: z
      .object({
        observe: z.boolean(),
      })
      .strict()
      .optional(),
    activeTurns: z
      .object({
        steer: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type HarnessSessionCapabilities = z.infer<typeof harnessSessionCapabilitiesSchema>;

export const harnessConfigurationStateSchema = z
  .object({
    effectiveModel: harnessModelRefSchema.optional(),
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: harnessThinkingOptionsSchema.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.effectiveThinkingOptionId &&
      state.availableThinkingOptions &&
      !state.availableThinkingOptions.some(({ id }) => id === state.effectiveThinkingOptionId)
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective Thinking option must be currently available",
        path: ["effectiveThinkingOptionId"],
      });
    }
  });

export type HarnessConfigurationState = z.infer<typeof harnessConfigurationStateSchema>;

export const harnessModelSelectionStateSchema = harnessConfigurationStateSchema;
export type HarnessModelSelectionState = HarnessConfigurationState;

export const harnessWebUiCapabilitySchema = z
  .object({
    open: z.literal(true),
  })
  .strict();

export type HarnessWebUiCapability = z.infer<typeof harnessWebUiCapabilitySchema>;

const readyHarnessInspectionSchema = z
  .object({
    status: z.literal("ready"),
    catalog: harnessModelCatalogSchema,
    permissionModes: harnessPermissionModeCatalogSchema.optional(),
    capabilities: harnessSessionCapabilitiesSchema,
    webUi: harnessWebUiCapabilitySchema.optional(),
  })
  .strict()
  .superRefine((inspection, context) => {
    const selectable = inspection.capabilities.configuration.selectPermissionMode;
    if (selectable !== Boolean(inspection.permissionModes)) {
      context.addIssue({
        code: "custom",
        message: "Permission Mode catalog and capability must agree",
        path: selectable
          ? ["permissionModes"]
          : ["capabilities", "configuration", "selectPermissionMode"],
      });
    }
  });

const failedHarnessInspectionSchema = z
  .object({
    status: z.enum(["notInstalled", "unavailable", "error"]),
    error: codexhostErrorSchema,
  })
  .strict();

export const harnessInspectionSchema = z.union([
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

export const harnessWebUiOpenParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
  })
  .strict();

export type HarnessWebUiOpenParams = z.infer<typeof harnessWebUiOpenParamsSchema>;

export const harnessWebUiOpenResultSchema = z.object({}).strict();

export type HarnessWebUiOpenResult = z.infer<typeof harnessWebUiOpenResultSchema>;

export const threadModelSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    model: harnessModelRefSchema,
  })
  .strict();

export type ThreadModelSelectParams = z.infer<typeof threadModelSelectParamsSchema>;

export const threadThinkingSelectParamsSchema = z
  .object({
    threadId: hostThreadIdSchema,
    thinkingOptionId: harnessThinkingOptionIdSchema,
  })
  .strict();

export type ThreadThinkingSelectParams = z.infer<typeof threadThinkingSelectParamsSchema>;

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
    resolvedModelLabel: harnessResolvedModelLabelSchema.optional(),
    effectiveThinkingOptionId: harnessThinkingOptionIdSchema.optional(),
    availableThinkingOptions: harnessThinkingOptionsSchema.optional(),
    effectivePermissionModeId: harnessPermissionModeIdSchema.optional(),
    history: harnessHistoryCapabilitiesSchema,
    usage: threadUsageSnapshotSchema.optional(),
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
