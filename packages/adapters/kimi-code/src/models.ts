import { parse as parseToml } from "smol-toml";

import {
  harnessModelCatalogSchema,
  harnessModelRefIdSchema,
  harnessModelRefSchema,
  harnessModelSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  harnessThinkingOptionSchema,
  type HarnessModel,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessPermissionModeCatalog,
  type HarnessThinkingOption,
  type HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

const KIMI_MODEL_PREFIX = "kimi.";

export function encodeKimiModelRef(alias: string): HarnessModelRef {
  const encoded = Buffer.from(alias, "utf8").toString("base64url");
  return harnessModelRefSchema.parse({
    id: harnessModelRefIdSchema.parse(`${KIMI_MODEL_PREFIX}${encoded}`),
  });
}

export function decodeKimiModelRefId(id: string): string {
  if (!id.startsWith(KIMI_MODEL_PREFIX)) {
    throw new Error(`Invalid Kimi model ref ID: ${id}`);
  }
  const payload = id.slice(KIMI_MODEL_PREFIX.length);
  return Buffer.from(payload, "base64url").toString("utf8");
}

export const KIMI_MODES = ["default", "plan", "auto", "yolo"] as const;
export type KimiModeId = (typeof KIMI_MODES)[number];

export function isKimiModeId(value: unknown): value is KimiModeId {
  return typeof value === "string" && (KIMI_MODES as readonly string[]).includes(value);
}

export const kimiPermissionModeCatalog: HarnessPermissionModeCatalog =
  harnessPermissionModeCatalogSchema.parse({
    defaultModeId: harnessPermissionModeIdSchema.parse("default"),
    modes: [
      {
        id: harnessPermissionModeIdSchema.parse("default"),
        label: "询问确认",
        description: "Manual approvals; tools execute normally.",
      },
      {
        id: harnessPermissionModeIdSchema.parse("plan"),
        label: "计划模式",
        description: "Read-only planning; no tool execution.",
      },
      {
        id: harnessPermissionModeIdSchema.parse("auto"),
        label: "按需询问",
        description: "Auto-approve safe operations.",
      },
      {
        id: harnessPermissionModeIdSchema.parse("yolo"),
        label: "无需询问",
        description: "Auto-approve everything.",
        dangerous: true,
      },
    ],
  });

export interface KimiNativeConfig {
  defaultModel?: string;
  models: Array<{
    alias: string;
    model?: string;
    provider?: string;
    maxContextSize?: number;
  }>;
  thinking?: {
    enabled?: boolean;
    effort?: string;
  };
}

export function parseKimiConfigToml(content: string): KimiNativeConfig {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Failed to parse Kimi config.toml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const defaultModel =
    typeof parsed.default_model === "string" ? parsed.default_model.trim() : undefined;
  const models: KimiNativeConfig["models"] = [];

  if (typeof parsed.models === "object" && parsed.models !== null) {
    for (const [alias, details] of Object.entries(parsed.models as Record<string, unknown>)) {
      const item: KimiNativeConfig["models"][number] = { alias };
      if (typeof details === "object" && details !== null) {
        const d = details as Record<string, unknown>;
        if (typeof d.model === "string") item.model = d.model;
        if (typeof d.provider === "string") item.provider = d.provider;
        if (typeof d.max_context_size === "number") item.maxContextSize = d.max_context_size;
      }
      models.push(item);
    }
  }

  let thinking: KimiNativeConfig["thinking"] = undefined;
  if (typeof parsed.thinking === "object" && parsed.thinking !== null) {
    const t = parsed.thinking as Record<string, unknown>;
    const th: { enabled?: boolean; effort?: string } = {};
    if (typeof t.enabled === "boolean") th.enabled = t.enabled;
    if (typeof t.effort === "string") th.effort = t.effort;
    thinking = th;
  }

  const config: KimiNativeConfig = { models };
  if (defaultModel) config.defaultModel = defaultModel;
  if (thinking) config.thinking = thinking;
  return config;
}

export function resolveKimiContextWindow(
  modelAlias?: string,
  config?: KimiNativeConfig | null,
): number {
  if (modelAlias && config?.models) {
    const found = config.models.find((m) => m.alias === modelAlias);
    if (found?.maxContextSize && found.maxContextSize > 0) {
      return found.maxContextSize;
    }
  }
  return 200_000;
}

export interface AcpConfigOptionChoice {
  value: string;
  name?: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  type?: string;
  category?: string;
  currentValue?: string;
  options?: AcpConfigOptionChoice[];
}

export function buildModelCatalogFromConfig(
  config: KimiNativeConfig,
  thinkingOptionsList?: HarnessThinkingOption[],
): HarnessModelCatalog {
  const fallbackThinkingOptions: HarnessThinkingOption[] = [
    { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
    { id: harnessThinkingOptionIdSchema.parse("low"), label: "Low" },
    { id: harnessThinkingOptionIdSchema.parse("medium"), label: "Medium" },
    { id: harnessThinkingOptionIdSchema.parse("high"), label: "High" },
    { id: harnessThinkingOptionIdSchema.parse("xhigh"), label: "Xhigh" },
    { id: harnessThinkingOptionIdSchema.parse("max"), label: "Max" },
  ];

  const thinkingOptions =
    thinkingOptionsList && thinkingOptionsList.length > 0
      ? thinkingOptionsList
      : fallbackThinkingOptions;

  const thinkingIds = thinkingOptions.map((opt) => opt.id);
  const rawModels =
    config.models.length > 0 ? config.models : [{ alias: config.defaultModel ?? "default" }];
  const models: HarnessModel[] = rawModels.map((m) => {
    const label = m.model ? `${m.alias} (${m.model})` : m.alias;
    return harnessModelSchema.parse({
      ref: encodeKimiModelRef(m.alias),
      label: label.slice(0, 256),
      ...(m.model ? { resolvedModelLabel: m.model.slice(0, 256) } : {}),
      supportedThinkingOptionIds: thinkingIds,
    });
  });

  const defaultModel =
    config.defaultModel &&
    models.some((m) => decodeKimiModelRefId(m.ref.id) === config.defaultModel)
      ? encodeKimiModelRef(config.defaultModel)
      : models[0]?.ref;

  let defaultThinkingOptionId: HarnessThinkingOptionId | undefined = undefined;
  if (
    config.thinking?.effort &&
    thinkingIds.includes(config.thinking.effort as HarnessThinkingOptionId)
  ) {
    defaultThinkingOptionId = harnessThinkingOptionIdSchema.parse(config.thinking.effort);
  } else if (
    config.thinking?.enabled === false &&
    thinkingIds.includes("off" as HarnessThinkingOptionId)
  ) {
    defaultThinkingOptionId = harnessThinkingOptionIdSchema.parse("off");
  } else if (thinkingIds.length > 0) {
    defaultThinkingOptionId = thinkingIds.includes("medium" as HarnessThinkingOptionId)
      ? harnessThinkingOptionIdSchema.parse("medium")
      : thinkingIds[0];
  }

  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions,
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}

export function parseAcpConfigOptions(configOptions: unknown[]): {
  modelOptions?: AcpConfigOption;
  thinkingOptions?: AcpConfigOption;
  modeOptions?: AcpConfigOption;
} {
  const result: {
    modelOptions?: AcpConfigOption;
    thinkingOptions?: AcpConfigOption;
    modeOptions?: AcpConfigOption;
  } = {};

  for (const raw of configOptions) {
    if (typeof raw !== "object" || raw === null) continue;
    const opt = raw as AcpConfigOption;
    if (opt.id === "model") result.modelOptions = opt;
    else if (opt.id === "thinking") result.thinkingOptions = opt;
    else if (opt.id === "mode") result.modeOptions = opt;
  }

  return result;
}

export function readKimiEffectiveConfig(configOptions: unknown[]): {
  modelAlias?: string;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: KimiModeId;
} {
  const { modelOptions, thinkingOptions, modeOptions } = parseAcpConfigOptions(configOptions);
  const thinking = harnessThinkingOptionIdSchema.safeParse(thinkingOptions?.currentValue);
  return {
    ...(modelOptions?.currentValue ? { modelAlias: modelOptions.currentValue } : {}),
    ...(thinking.success ? { thinkingOptionId: thinking.data } : {}),
    ...(isKimiModeId(modeOptions?.currentValue)
      ? { permissionModeId: modeOptions.currentValue }
      : {}),
  };
}

export function formatThinkingLabel(raw: string): string {
  const stripped = raw.replace(/^Thinking\s+/iu, "").trim();
  if (!stripped) return raw;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

export function buildModelCatalogFromAcp(
  configOptions: unknown[],
  fallbackConfig?: KimiNativeConfig,
): HarnessModelCatalog {
  const { modelOptions, thinkingOptions } = parseAcpConfigOptions(configOptions);

  const thinking: HarnessThinkingOption[] = [];
  if (thinkingOptions?.options && Array.isArray(thinkingOptions.options)) {
    for (const opt of thinkingOptions.options) {
      if (typeof opt.value === "string" && opt.value.trim().length > 0) {
        const rawLabel = opt.name || opt.value;
        thinking.push(
          harnessThinkingOptionSchema.parse({
            id: harnessThinkingOptionIdSchema.parse(opt.value),
            label: formatThinkingLabel(rawLabel).slice(0, 256),
          }),
        );
      }
    }
  }

  if (thinking.length === 0) {
    thinking.push(
      { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
      { id: harnessThinkingOptionIdSchema.parse("medium"), label: "Medium" },
      { id: harnessThinkingOptionIdSchema.parse("high"), label: "High" },
    );
  }

  const thinkingIds = thinking.map((t) => t.id);
  const models: HarnessModel[] = [];

  if (modelOptions?.options && Array.isArray(modelOptions.options)) {
    for (const opt of modelOptions.options) {
      if (typeof opt.value === "string" && opt.value.trim().length > 0) {
        const alias = opt.value;
        const displayName = opt.name || alias;
        models.push(
          harnessModelSchema.parse({
            ref: encodeKimiModelRef(alias),
            label: displayName.slice(0, 256),
            supportedThinkingOptionIds: thinkingIds,
          }),
        );
      }
    }
  }

  if (models.length === 0 && fallbackConfig) {
    return buildModelCatalogFromConfig(fallbackConfig, thinking);
  }

  const currentModelAlias = modelOptions?.currentValue;
  const defaultModel =
    currentModelAlias && models.some((m) => decodeKimiModelRefId(m.ref.id) === currentModelAlias)
      ? encodeKimiModelRef(currentModelAlias)
      : models[0]?.ref;

  const currentThinking = thinkingOptions?.currentValue;
  const defaultThinkingOptionId =
    currentThinking && thinkingIds.includes(currentThinking as HarnessThinkingOptionId)
      ? harnessThinkingOptionIdSchema.parse(currentThinking)
      : thinkingIds[0];

  return harnessModelCatalogSchema.parse({
    models,
    ...(defaultModel ? { defaultModel } : {}),
    thinkingOptions: thinking,
    ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
  });
}
