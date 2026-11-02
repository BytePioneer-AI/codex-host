import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import type {
  HarnessModelCatalog,
  HarnessPermissionModeCatalog,
  HarnessSessionCapabilities,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { DevinSessionInfo } from "./transport.js";

export const DEVIN_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
};

export function devinCapabilities(info: DevinSessionInfo): HarnessSessionCapabilities {
  return {
    ...DEVIN_CAPABILITIES,
    history: {
      fork: info.nativeHistory === true,
      forkAcrossCwd: false,
      rollbackLastTurn: info.nativeHistory === true,
    },
    configuration: {
      ...DEVIN_CAPABILITIES.configuration,
      selectThinkingOption: devinThinking(info).options.length > 0,
    },
  };
}

/** Devin session/new and session/load return `modes`; bypass exposes every tool. */
export function devinModes(info: DevinSessionInfo): HarnessPermissionModeCatalog {
  const available = info.modes?.availableModes ?? [];
  const modes = available.map((mode) => ({
    id: harnessPermissionModeIdSchema.parse(mode.id),
    label: mode.name,
    ...(mode.description ? { description: mode.description } : {}),
    ...(mode.id === "bypass" ? { dangerous: true } : {}),
  }));
  const current = info.modes?.currentModeId;
  if (!modes.length || !current || !modes.some((mode) => mode.id === current))
    throw new Error("Devin returned no usable permission mode catalog");
  return harnessPermissionModeCatalogSchema.parse({ modes, defaultModeId: current });
}

export const devinModelRef = (nativeId: string) =>
  harnessModelRefSchema.parse({ id: `devin.${Buffer.from(nativeId).toString("base64url")}` });

export function devinModels(info: DevinSessionInfo) {
  const option =
    info.configOptions?.find((option) => option.category === "model") ??
    info.configOptions?.find((option) => option.id === "model");
  if (!option || option.type !== "select") throw new Error("Devin returned no model configuration");
  const models = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  if (!models.some(({ value }) => value === option.currentValue))
    throw new Error("Devin Model current value is absent from its native options");
  return { models, current: option.currentValue, configId: option.id };
}

/** Values stay opaque to Host, including native values containing transport-unsafe characters. */
export const devinThinkingOptionId = (value: string) =>
  harnessThinkingOptionIdSchema.parse(`devin.${Buffer.from(value).toString("base64url")}`);

export function devinThinking(info: DevinSessionInfo) {
  // ACP ordering resolves ties. Names and IDs are not semantic categories.
  const selector = info.configOptions?.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.category === "thought_level" && option.type === "select",
  );
  const values =
    selector?.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options)) ?? [];
  const options = values.map(({ value, name }) => ({
    id: devinThinkingOptionId(value),
    label: name,
  }));
  if (options.length && !values.some(({ value }) => value === selector?.currentValue))
    throw new Error("Devin Thinking current value is absent from its native options");
  return {
    selector,
    values,
    options,
    ...(options.length && selector
      ? { current: devinThinkingOptionId(selector.currentValue) }
      : {}),
  };
}

export function devinConfigurationState(info: DevinSessionInfo): HarnessSessionState {
  const current = devinModels(info).current;
  const thinking = devinThinking(info);
  const mode = info.configOptions?.find(
    (option) => option.category === "mode" || option.id === "mode",
  );
  return {
    ...(current ? { effectiveModel: devinModelRef(current) } : {}),
    ...(thinking.current ? { effectiveThinkingOptionId: thinking.current } : {}),
    availableThinkingOptions: thinking.options,
    effectivePermissionModeId:
      mode?.type === "select"
        ? harnessPermissionModeIdSchema.parse(mode.currentValue)
        : devinModes(info).defaultModeId,
  };
}

export function devinCatalog(info: DevinSessionInfo): HarnessModelCatalog {
  const native = devinModels(info);
  const thinking = devinThinking(info);
  const models = native.models.map((model) => ({
    ref: devinModelRef(model.value),
    label: model.name,
    // ACP describes the active Model's options, not all other Models' capabilities.
    ...(model.value === native.current
      ? { supportedThinkingOptionIds: thinking.options.map(({ id }) => id) }
      : {}),
  }));
  if (!models.length) throw new Error("Devin returned no model catalog");
  const current = native.current;
  return {
    models,
    ...(current && models.some((model) => model.ref.id === devinModelRef(current).id)
      ? { defaultModel: devinModelRef(current) }
      : {}),
    thinkingOptions: thinking.options,
    ...(thinking.current ? { defaultThinkingOptionId: thinking.current } : {}),
  };
}

export function devinNativeModel(info: DevinSessionInfo, ref: string): string {
  const native = devinModels(info).models.find((model) => devinModelRef(model.value).id === ref);
  if (!native) throw new Error("Model is not in this Devin session's native catalog");
  return native.value;
}
