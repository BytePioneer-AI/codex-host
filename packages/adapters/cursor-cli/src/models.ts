import {
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import type { HarnessModelCatalog, HarnessSessionCapabilities } from "@codexhost/harness-adapter";
import type { CursorSessionInfo, CursorNativeModel } from "./transport.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { cursorThinking, cursorThinkingState } from "./thinking.js";
import { cursorForkAvailable } from "./fork-support.js";

export const CURSOR_CAPABILITIES: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: false,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: {
    fork: cursorForkAvailable(),
    forkAcrossCwd: false,
    rollbackLastTurn: cursorForkAvailable(),
  },
  subagents: { observe: true, readTranscript: false },
};
export const CURSOR_MODES = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "agent",
  modes: [
    { id: "agent", label: "Agent", description: "Native agent mode with Cursor tool approvals" },
    { id: "plan", label: "Plan", description: "Native read-only planning mode" },
    { id: "ask", label: "Ask", description: "Native read-only question mode" },
  ],
});
export const cursorModelRef = (nativeId: string) =>
  harnessModelRefSchema.parse({ id: `cursor.${Buffer.from(nativeId).toString("base64url")}` });
export function cursorModels(info: CursorSessionInfo) {
  const option = info.configOptions?.find((option) => option.id === "model");
  if (!option || option.type !== "select")
    throw new Error("Cursor returned no model configuration");
  const models = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
  return { models, current: option.currentValue };
}
export function cursorCatalog(info: CursorSessionInfo): HarnessModelCatalog {
  const native = cursorModels(info);
  const thinking = new Map<
    string,
    { id: ReturnType<typeof cursorThinking>[number]["id"]; label: string }
  >();
  const models = native.models.map((model) => {
    const config =
      model.value === native.current
        ? info.configOptions
        : info.nativeModels?.find((entry) => entry.value === model.value)?.configOptions;
    const options = cursorThinking(config);
    for (const { id, label } of options) thinking.set(id, { id, label });
    return {
      ref: cursorConfiguredModelRef(model.value, config),
      label: model.name,
      supportedThinkingOptionIds: options.map(({ id }) => id),
    };
  });
  if (!models.length) throw new Error("Cursor returned no model catalog");
  const current = cursorThinkingState(info).effectiveThinkingOptionId;
  return {
    models,
    defaultModel: cursorConfiguredModelRef(native.current, info.configOptions),
    thinkingOptions: [...thinking.values()],
    ...(current ? { defaultThinkingOptionId: current } : {}),
  };
}
export function cursorNativeModel(info: CursorSessionInfo, ref: string): string {
  const native = cursorModels(info).models.find((model) => cursorModelRef(model.value).id === ref);
  if (!native) throw new Error("Model is not in this Cursor session's native catalog");
  return native.value;
}

/** Validate the private extension at its boundary; retain only select configuration. */
export function parseCursorNativeModels(input: Record<string, unknown>): CursorNativeModel[] {
  if (!Array.isArray(input.models))
    throw new Error("Cursor returned no parameterized model catalog");
  return input.models.map((model: unknown) => {
    if (
      typeof model !== "object" ||
      model === null ||
      !("value" in model) ||
      !("name" in model) ||
      !("configOptions" in model) ||
      typeof model.value !== "string" ||
      typeof model.name !== "string" ||
      !Array.isArray(model.configOptions)
    )
      throw new Error("Invalid Cursor model metadata");
    return {
      value: model.value,
      name: model.name,
      configOptions: model.configOptions.map((option: unknown) => {
        if (
          typeof option !== "object" ||
          option === null ||
          !("id" in option) ||
          !("name" in option) ||
          !("type" in option) ||
          !("currentValue" in option) ||
          !("options" in option) ||
          typeof option.id !== "string" ||
          typeof option.name !== "string" ||
          option.type !== "select" ||
          typeof option.currentValue !== "string" ||
          !Array.isArray(option.options)
        )
          throw new Error("Invalid Cursor parameter metadata");
        const entries = option.options.map((entry: unknown) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            !("value" in entry) ||
            !("name" in entry) ||
            typeof entry.value !== "string" ||
            typeof entry.name !== "string"
          )
            throw new Error("Invalid Cursor parameter choice");
          return { value: entry.value, name: entry.name };
        });
        return {
          id: option.id,
          name: option.name,
          type: "select" as const,
          currentValue: option.currentValue,
          options: entries,
          ...("category" in option && typeof option.category === "string"
            ? { category: option.category }
            : {}),
        };
      }),
    };
  });
}

export function cursorModelSelection(
  info: CursorSessionInfo,
  ref: string,
): Array<[string, string]> {
  const exact = cursorModels(info).models.find((model) => cursorModelRef(model.value).id === ref);
  if (exact) return [["model", exact.value]];
  // Revalidate legacy bracketed refs against native parameter metadata before changing anything.
  if (!ref.startsWith("cursor.")) throw new Error("Unknown Cursor model reference");
  const decoded = Buffer.from(ref.slice(7), "base64url").toString();
  if (cursorModelRef(decoded).id !== ref) throw new Error("Invalid Cursor model reference");
  const match = /^([^\[\]]+)\[([^\[\]]*)\]$/u.exec(decoded);
  const model = match && info.nativeModels?.find((entry) => entry.value === match[1]);
  if (!match || !model) throw new Error("Model is not in this Cursor session's native catalog");
  const parameters: Array<[string, string]> = [];
  for (const parameter of match[2] ? match[2].split(",") : []) {
    const pair = parameter.split("=");
    const [id, value] = pair;
    if (pair.length !== 2 || !id || value === undefined || parameters.some(([key]) => key === id))
      throw new Error("Invalid Cursor model parameters");
    const option = model.configOptions.find((option) => option.id === id);
    if (
      !option ||
      option.type !== "select" ||
      !option.options
        .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
        .some((entry) => entry.value === value)
    )
      throw new Error("Legacy Cursor model parameter is not selectable in the native catalog");
    parameters.push([id, value]);
  }
  return [["model", model.value], ...parameters];
}

export function cursorCapabilities(info: CursorSessionInfo): HarnessSessionCapabilities {
  return {
    ...CURSOR_CAPABILITIES,
    configuration: {
      ...CURSOR_CAPABILITIES.configuration,
      selectThinkingOption: cursorCatalog(info).thinkingOptions.length > 0,
    },
  };
}

/** Keep native non-Thinking parameters in the persisted Model Ref across Host restarts. */
export function cursorConfiguredModelRef(model: string, options?: SessionConfigOption[] | null) {
  const parameters = (options ?? []).flatMap((option) =>
    option.category === "model_config" && option.type === "select"
      ? [`${option.id}=${option.currentValue}`]
      : [],
  );
  return cursorModelRef(parameters.length ? `${model}[${parameters.join(",")}]` : model);
}
