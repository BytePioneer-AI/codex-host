import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
  type HarnessModelRef,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  parseHostUsage,
  type HarnessSessionState,
  type HostUsage,
} from "@codexhost/harness-adapter";
import {
  nativeModelSchema,
  type NativeModel,
  type NativeSettings,
  type NativeSnapshot,
  runtimeUsageSchema,
} from "./protocol.js";
import { ZcodeError } from "./errors.js";

export const ZCODE_ID = harnessIdSchema.parse("zcode");
export function encodeModel(model: NativeModel): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id: `zcode-local-v1.${Buffer.from(JSON.stringify([model.providerId, model.modelId])).toString("base64url")}`,
  });
}
export function decodeModel(model: HarnessModelRef): NativeModel {
  try {
    const prefix = "zcode-local-v1.";
    const value: unknown = JSON.parse(
      Buffer.from(model.id.slice(prefix.length), "base64url").toString("utf8"),
    );
    if (!model.id.startsWith(prefix) || !Array.isArray(value) || value.length !== 2)
      throw new Error();
    const native = nativeModelSchema.parse({ providerId: value[0], modelId: value[1] });
    if (encodeModel(native).id !== model.id) throw new Error();
    return native;
  } catch {
    throw new ZcodeError("invalidRequest", "Invalid ZCode model reference");
  }
}
/** Creation/model selection uses the native catalog's completion rule, never a Host default. */
export function selectNativeModel(
  model: HarnessModelRef,
  settings: NativeSettings,
  thinkingOption?: string,
): NativeModel {
  const native = decodeModel(model);
  const entry = settings.model.available.find(
    (entry) => encodeModel(entry.ref).id === model.id && !entry.disabledReason,
  );
  if (!entry) throw new ZcodeError("invalidRequest", "ZCode model is not available");
  const current = settings.model.current;
  const level =
    thinkingOption ??
    (current && encodeModel(current).id === model.id
      ? current.options?.reasoningLevel
      : undefined) ??
    entry.reasoning?.defaultLevel;
  if (level === undefined) return native;
  if (!entry.reasoning?.levels.some((option) => option.value === level))
    throw new ZcodeError("invalidRequest", "ZCode thinking option is not available for this model");
  return { ...native, options: { reasoningLevel: level } };
}

export function modelCatalog(settings: NativeSettings) {
  const available = settings.model.available.filter((model) => !model.disabledReason);
  const levels = new Map(settings.thoughtLevel.available.map((level) => [level.value, level]));
  for (const model of available)
    for (const level of model.reasoning?.levels ?? []) levels.set(level.value, level);
  const current = settings.model.current ? encodeModel(settings.model.current) : undefined;
  const defaultThinking = settings.thoughtLevel.current ?? settings.thoughtLevel.defaultLevel;
  return harnessModelCatalogSchema.parse({
    models: available.map((model) => ({
      ref: encodeModel(model.ref),
      label: model.label,
      supportedThinkingOptionIds: model.reasoning?.enabled
        ? model.reasoning.levels.map((level) => level.value)
        : [],
    })),
    ...(current && available.some((model) => encodeModel(model.ref).id === current.id)
      ? { defaultModel: current }
      : {}),
    thinkingOptions: [...levels.values()].map((level) => ({ id: level.value, label: level.label })),
    ...(defaultThinking && levels.has(defaultThinking)
      ? { defaultThinkingOptionId: defaultThinking }
      : {}),
  });
}
const modeLabels = {
  build: "Confirm changes",
  edit: "Auto edit",
  plan: "Plan",
  yolo: "Full access",
  auto: "Auto",
};
export function permissionModes(current: NativeSettings["mode"]["current"] = "build") {
  return harnessPermissionModeCatalogSchema.parse({
    modes: Object.entries(modeLabels).map(([id, label]) => ({
      id,
      label,
      ...(id === "yolo" ? { dangerous: true } : {}),
    })),
    defaultModeId: current,
  });
}
export function sessionState(snapshot: NativeSnapshot, locator?: JsonObject): HarnessSessionState {
  const settings = snapshot.settings;
  const current = settings.model.current ? encodeModel(settings.model.current) : undefined;
  const model = settings.model.available.find(
    (candidate) => encodeModel(candidate.ref).id === current?.id,
  );
  return {
    nativeRef: nativeSessionRefSchema.parse({
      harnessId: ZCODE_ID,
      nativeSessionId: snapshot.session.sessionId,
      formatVersion: 1,
      locator: { ...locator, cwd: snapshot.session.workspace.workspacePath },
    }),
    ...(current && settings.model.current?.providerId !== "zcode-unconfigured"
      ? { effectiveModel: current }
      : {}),
    ...(model ? { resolvedModelLabel: model.label } : {}),
    ...(settings.thoughtLevel.enabled && settings.thoughtLevel.current
      ? {
          effectiveThinkingOptionId: harnessThinkingOptionIdSchema.parse(
            settings.thoughtLevel.current,
          ),
        }
      : {}),
    availableThinkingOptions: settings.thoughtLevel.available.map((level) => ({
      id: harnessThinkingOptionIdSchema.parse(level.value),
      label: level.label,
    })),
    effectivePermissionModeId: harnessPermissionModeIdSchema.parse(settings.mode.current),
  };
}
/**
 * Context and cache usage of a Session. The window comes from the full Model catalog: the
 * session projection keeps the CLI's initial 200000 and never follows the selected Model, and
 * `session/read` copies that value over the current Model entry. Used tokens and cache counters
 * come from `runtime.contextUsage`; a Session that has made no request yet has neither.
 */
export function sessionUsage(snapshot: NativeSnapshot, catalog: NativeSettings): HostUsage | null {
  const runtime = runtimeUsageSchema.safeParse(snapshot.runtime).data?.contextUsage;
  const current = snapshot.settings.model.current;
  const window =
    catalog.model.available.find(
      (model) =>
        model.ref.providerId === current?.providerId && model.ref.modelId === current.modelId,
    )?.contextWindow ?? snapshot.projection.contextWindow;
  const cache = runtime?.cache;
  const usage: HostUsage = {
    ...(window > 0
      ? {
          contextUsedTokens: runtime?.used ?? snapshot.projection.contextUsed,
          contextWindowTokens: window,
        }
      : {}),
    ...(cache
      ? {
          cachedInputTokens: cache.totalCacheReadTokens,
          cacheWriteInputTokens: cache.totalCacheWriteTokens,
          ...(typeof cache.latestHitRate === "number"
            ? { cacheHitRatePercent: cache.latestHitRate * 100 }
            : {}),
        }
      : {}),
  };
  return Object.keys(usage).length > 0 ? parseHostUsage(usage) : null;
}
