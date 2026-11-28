import {
  catalogModelForRef,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  type HarnessModelRef,
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
    {
      id: "agent",
      label: "Agent",
      description: "Native agent mode with Cursor tool approvals",
      localizations: {
        "zh-CN": { description: "执行任务，可修改文件和运行命令；需要审批的操作仍会请求确认。" },
      },
    },
    {
      id: "plan",
      label: "Plan",
      description: "Native read-only planning mode",
      localizations: {
        "zh-CN": { label: "规划模式", description: "只读分析代码并制定实施计划，不修改项目文件。" },
      },
    },
    {
      id: "ask",
      label: "Ask",
      description: "Native read-only question mode",
      localizations: {
        "zh-CN": { label: "询问", description: "只读查看代码并回答问题，不修改项目文件。" },
      },
    },
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
function isCursorFastOption(option: SessionConfigOption): boolean {
  if (option.id !== "fast" || option.category !== "model_config" || option.type !== "select")
    return false;
  const values = option.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map(({ value }) => value),
  );
  return values.includes("true") && values.includes("false");
}
export function cursorCatalog(info: CursorSessionInfo): HarnessModelCatalog {
  const native = cursorModels(info);
  const thinking = new Map<
    string,
    { id: ReturnType<typeof cursorThinking>[number]["id"]; label: string }
  >();
  const models = native.models.map((model) => {
    const live = model.value === native.current;
    const config = live
      ? info.configOptions
      : info.nativeModels?.find((entry) => entry.value === model.value)?.configOptions;
    const options = cursorThinking(config);
    for (const { id, label } of options) thinking.set(id, { id, label });
    // Pin only `fast` so every Model keeps the same Ref in inspection and live catalogs, while
    // leaving other `model_config` parameters (such as `context`) to Cursor's per-model settings.
    const fast = config?.find(isCursorFastOption);
    const withFast = (option: SessionConfigOption, value: string) =>
      cursorConfiguredModelRef(model.value, [
        { ...option, currentValue: value } as SessionConfigOption,
      ]);
    return {
      ref: fast ? withFast(fast, "false") : cursorModelRef(model.value),
      ...(fast ? { fastModel: withFast(fast, "true") } : {}),
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

function decodeCursorModelRef(ref: string): string | undefined {
  if (!ref.startsWith("cursor.")) return undefined;
  const decoded = Buffer.from(ref.slice(7), "base64url").toString();
  return cursorModelRef(decoded).id === ref ? decoded : undefined;
}

function parseCursorParameters(raw: string): Array<[string, string]> | undefined {
  const parameters: Array<[string, string]> = [];
  for (const parameter of raw ? raw.split(",") : []) {
    const pair = parameter.split("=");
    const [id, value] = pair;
    if (pair.length !== 2 || !id || value === undefined || parameters.some(([key]) => key === id))
      return undefined;
    parameters.push([id, value]);
  }
  return parameters;
}

function catalogEntryBaseModel(entry: HarnessModelCatalog["models"][number]): string | undefined {
  const decoded = decodeCursorModelRef(entry.ref.id);
  if (!decoded) return undefined;
  if (entry.fastModel) {
    const match = /^([^\[\]]+)\[([^\[\]]*)\]$/u.exec(decoded);
    const parameters = match ? parseCursorParameters(match[2] ?? "") : undefined;
    if (
      match?.[1] &&
      parameters?.length === 1 &&
      parameters[0]?.[0] === "fast" &&
      parameters[0]?.[1] === "false"
    )
      return match[1];
  }
  return decoded;
}

/** Map a stored Cursor Model Ref (including legacy parameterized forms) to the matching catalog entry. */
export function normalizeStoredCursorModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  if (catalogModelForRef(catalog, ref)) return ref;
  if (ref.serviceTier) return undefined;
  const decoded = decodeCursorModelRef(ref.id);
  if (!decoded) return undefined;
  let baseModel = decoded;
  let fastValue: string | undefined;
  if (decoded.includes("[") || decoded.includes("]")) {
    const match = /^([^\[\]]+)\[([^\[\]]*)\]$/u.exec(decoded);
    const parameters = match ? parseCursorParameters(match[2] ?? "") : undefined;
    if (!match?.[1] || !parameters) return undefined;
    baseModel = match[1];
    fastValue = parameters.find(([id]) => id === "fast")?.[1];
    if (fastValue !== undefined && fastValue !== "true" && fastValue !== "false") return undefined;
  }
  const entry = catalog.models.find((model) => catalogEntryBaseModel(model) === baseModel);
  if (!entry) return undefined;
  return fastValue === "true" && entry.fastModel ? entry.fastModel : entry.ref;
}

export function cursorModelSelection(
  info: CursorSessionInfo,
  ref: string,
): Array<[string, string]> {
  const exact = cursorModels(info).models.find((model) => cursorModelRef(model.value).id === ref);
  if (exact) return [["model", exact.value]];
  // Revalidate bracketed refs against native parameter metadata before changing anything.
  if (!ref.startsWith("cursor.")) throw new Error("Unknown Cursor model reference");
  const decoded = decodeCursorModelRef(ref);
  if (decoded === undefined) throw new Error("Invalid Cursor model reference");
  const match = /^([^\[\]]+)\[([^\[\]]*)\]$/u.exec(decoded);
  const model = match && info.nativeModels?.find((entry) => entry.value === match[1]);
  if (!match || !model) throw new Error("Model is not in this Cursor session's native catalog");
  const parameters = parseCursorParameters(match[2] ?? "");
  if (!parameters) throw new Error("Invalid Cursor model parameters");
  for (const [id, value] of parameters) {
    const option = model.configOptions.find((option) => option.id === id);
    if (
      !option ||
      option.type !== "select" ||
      !option.options
        .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
        .some((entry) => entry.value === value)
    )
      throw new Error("Legacy Cursor model parameter is not selectable in the native catalog");
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

/** Encode the model ID with its Fast toggle when advertised, omitting session-scoped parameters. */
export function cursorConfiguredModelRef(model: string, options?: SessionConfigOption[] | null) {
  const fast = options?.find(isCursorFastOption);
  return cursorModelRef(fast ? `${model}[fast=${fast.currentValue}]` : model);
}
