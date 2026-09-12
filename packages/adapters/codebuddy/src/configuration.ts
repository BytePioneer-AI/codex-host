import type {
  HarnessModelRef,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionSchema,
} from "@codexhost/shared-contracts";
import { CodeBuddyError, record, rows, text } from "./common.js";

export const CODEBUDDY_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  subagents: { observe: true, readTranscript: true },
};

export function modelRef(modelId: string): HarnessModelRef {
  return harnessModelRefSchema.parse({ id: `cb.${Buffer.from(modelId).toString("base64url")}` });
}

export function nativeModel(ref: HarnessModelRef): string {
  const value = Buffer.from(ref.id.slice(3), "base64url").toString("utf8");
  if (!value || !ref.id.startsWith("cb.") || modelRef(value).id !== ref.id)
    throw new CodeBuddyError("invalidRequest", "Invalid CodeBuddy Model Ref");
  return value;
}

export function configuration(value: unknown) {
  const options = rows(value);
  const get = (id: string) => options.find((option) => option.id === id) ?? {};
  const model = get("model"),
    mode = get("mode"),
    thought = get("thought_level");
  const thinkingOptions = rows(thought.options).map((option) =>
    harnessThinkingOptionSchema.parse({ id: option.value, label: option.name }),
  );
  const currentThinking = thinkingOptions.find((option) => option.id === thought.currentValue);
  const models = rows(model.options).map((option) => ({
    ref: modelRef(text(option.value)),
    label: text(option.name),
  }));
  const currentModel = models.find((item) => item.ref.id === modelRef(text(model.currentValue)).id);
  if (!currentModel)
    throw new CodeBuddyError("protocolError", "ACP did not report a valid current Model");
  const catalog = harnessModelCatalogSchema.parse({
    models: models.map((item) => ({
      ...item,
      ...(item === currentModel
        ? { supportedThinkingOptionIds: thinkingOptions.map((option) => option.id) }
        : {}),
    })),
    defaultModel: currentModel.ref,
    thinkingOptions,
    ...(currentThinking ? { defaultThinkingOptionId: currentThinking.id } : {}),
  });
  const permissionModes = harnessPermissionModeCatalogSchema.parse({
    modes: rows(mode.options).map((option) => ({
      id: option.value,
      label: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(["bypassPermissions", "fullAccess"].includes(text(option.value))
        ? { dangerous: true }
        : {}),
    })),
    defaultModeId: mode.currentValue,
  });
  const state: HarnessSessionState = {
    effectiveModel: currentModel.ref,
    resolvedModelLabel: currentModel.label,
    effectivePermissionModeId: harnessPermissionModeIdSchema.parse(mode.currentValue),
    availableThinkingOptions: thinkingOptions,
    ...(currentThinking ? { effectiveThinkingOptionId: currentThinking.id } : {}),
  };
  return { catalog, permissionModes, state, options };
}

export function confirmedConfiguration(response: unknown, id: string, value: string) {
  const result = configuration(record(response).configOptions);
  if (result.options.find((option) => option.id === id)?.currentValue !== value) {
    throw new CodeBuddyError("protocolError", `ACP did not confirm ${id}`);
  }
  return result;
}
