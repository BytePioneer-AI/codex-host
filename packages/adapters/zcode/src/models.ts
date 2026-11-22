import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  harnessModelRefSchema,
  harnessPermissionModeCatalogSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type JsonObject,
} from "@codexhost/shared-contracts";
import {
  compositeModelRefIds,
  parseHostUsage,
  type HarnessSessionState,
  type HostUsage,
} from "@codexhost/harness-adapter";
import {
  type NativeModel,
  type NativeSettings,
  type NativeSnapshot,
  runtimeUsageSchema,
} from "./protocol.js";
import { ZcodeError } from "./errors.js";

export const ZCODE_ID = harnessIdSchema.parse("zcode");
function readableId({ providerId, modelId }: NativeModel): string {
  return `${providerId}/${modelId}`;
}

function legacyId({ providerId, modelId }: NativeModel): string {
  return `zcode-local-v1.${Buffer.from(JSON.stringify([providerId, modelId])).toString("base64url")}`;
}

export function sameNativeModel(a: NativeModel, b: NativeModel): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

function modelIndex(models: NativeSettings["model"]["available"]) {
  const entries = new Map(
    models.map((entry) => [
      legacyId(entry.ref),
      {
        provider: entry.ref.providerId,
        model: entry.ref.modelId,
        entry,
      },
    ]),
  );
  const ids = compositeModelRefIds([...entries.values()], ({ entry }) => legacyId(entry.ref));
  const readable = new Set(models.map(({ ref }) => readableId(ref)));
  const byLegacy = new Map<string, HarnessModelRef>();
  for (const [id, { entry }] of ids) {
    byLegacy.set(legacyId(entry.ref), harnessModelRefSchema.parse({ id }));
  }
  const encode = (model: NativeModel): HarnessModelRef => {
    const id = readableId(model);
    return (
      byLegacy.get(legacyId(model)) ??
      harnessModelRefSchema.parse({
        id: readable.has(id) ? legacyId(model) : id,
      })
    );
  };
  return { encode, ids, byLegacy };
}

export type ZcodeModelIndex = ReturnType<typeof modelIndex>;

export function encodeModel(model: NativeModel, index?: ZcodeModelIndex): HarnessModelRef {
  return index?.encode(model) ?? harnessModelRefSchema.parse({ id: readableId(model) });
}

export function normalizeStoredZcodeModelRef(ref: HarnessModelRef, index: ZcodeModelIndex) {
  return ref.serviceTier ? undefined : index.byLegacy.get(ref.id);
}
/** Creation/model selection uses the native catalog's completion rule, never a Host default. */
export function selectNativeModel(
  model: HarnessModelRef,
  index: ZcodeModelIndex,
  current?: NativeModel,
  thinkingOption?: string,
): NativeModel {
  const entry = !model.serviceTier && index.ids.get(model.id)?.entry;
  if (!entry) throw new ZcodeError("invalidRequest", "ZCode model is not available");
  const { providerId, modelId } = entry.ref;
  const native = { providerId, modelId };
  const level =
    thinkingOption ??
    (current && sameNativeModel(current, native) ? current.options?.reasoningLevel : undefined) ??
    entry.reasoning?.defaultLevel;
  if (level === undefined) return native;
  if (!entry.reasoning?.levels.some((option) => option.value === level))
    throw new ZcodeError("invalidRequest", "ZCode thinking option is not available for this model");
  return { ...native, options: { reasoningLevel: level } };
}

export function modelCatalog(settings: NativeSettings): {
  catalog: HarnessModelCatalog;
  index: ZcodeModelIndex;
} {
  const available = settings.model.available.filter((model) => !model.disabledReason);
  const levels = new Map(settings.thoughtLevel.available.map((level) => [level.value, level]));
  for (const model of available)
    for (const level of model.reasoning?.levels ?? []) levels.set(level.value, level);
  const index = modelIndex(available);
  const current = settings.model.current ? index.encode(settings.model.current) : undefined;
  const defaultThinking = settings.thoughtLevel.current ?? settings.thoughtLevel.defaultLevel;
  const catalog = harnessModelCatalogSchema.parse({
    models: available.map((model) => ({
      ref: index.encode(model.ref),
      label: model.label,
      supportedThinkingOptionIds: model.reasoning?.enabled
        ? model.reasoning.levels.map((level) => level.value)
        : [],
    })),
    ...(current && index.ids.has(current.id) ? { defaultModel: current } : {}),
    thinkingOptions: [...levels.values()].map((level) => ({ id: level.value, label: level.label })),
    ...(defaultThinking && levels.has(defaultThinking)
      ? { defaultThinkingOptionId: defaultThinking }
      : {}),
  });
  return { catalog, index };
}
const modeLabels = {
  build: "Confirm changes",
  edit: "Auto edit",
  plan: "Plan",
  yolo: "Full access",
  auto: "Auto",
};
const chineseModeLabels: Readonly<Record<string, string>> = {
  build: "确认变更",
  edit: "自动编辑",
  plan: "规划模式",
  yolo: "完全访问",
  auto: "自动",
};
export function permissionModes(current: NativeSettings["mode"]["current"] = "build") {
  return harnessPermissionModeCatalogSchema.parse({
    modes: Object.entries(modeLabels).map(([id, label]) => ({
      id,
      label,
      localizations: { "zh-CN": { label: chineseModeLabels[id] } },
      ...(id === "yolo" ? { dangerous: true } : {}),
    })),
    defaultModeId: current,
  });
}
export function sessionState(
  snapshot: NativeSnapshot,
  locator?: JsonObject,
  index = modelCatalog(snapshot.settings).index,
): HarnessSessionState {
  const settings = snapshot.settings;
  const native = settings.model.current;
  const current = native ? encodeModel(native, index) : undefined;
  const model =
    native && settings.model.available.find((candidate) => sameNativeModel(candidate.ref, native));
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
