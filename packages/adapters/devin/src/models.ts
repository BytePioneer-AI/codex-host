import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";
import type {
  HarnessModelCatalog,
  HarnessPermissionModeCatalog,
  HarnessSessionCapabilities,
} from "@codexhost/harness-adapter";
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
  const option = info.configOptions?.find((option) => option.id === "model");
  if (!option || option.type !== "select") throw new Error("Devin returned no model configuration");
  const models = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return { models, current: option.currentValue };
}

export function devinCatalog(info: DevinSessionInfo): HarnessModelCatalog {
  const native = devinModels(info);
  const models = native.models.map((model) => ({
    ref: devinModelRef(model.value),
    label: model.name,
  }));
  if (!models.length) throw new Error("Devin returned no model catalog");
  const current = native.current;
  return {
    models,
    ...(current && models.some((model) => model.ref.id === devinModelRef(current).id)
      ? { defaultModel: devinModelRef(current) }
      : {}),
    thinkingOptions: [],
  };
}

export function devinNativeModel(info: DevinSessionInfo, ref: string): string {
  const native = devinModels(info).models.find((model) => devinModelRef(model.value).id === ref);
  if (!native) throw new Error("Model is not in this Devin session's native catalog");
  return native.value;
}
