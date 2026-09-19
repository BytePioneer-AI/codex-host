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
} from "./protocol.js";
import { ZcodeError } from "./errors.js";

export const ZCODE_ID = harnessIdSchema.parse("zcode");
export function modelBackend(model: HarnessModelRef): "desktop" | "stdio" {
  return model.id.startsWith("zcode-desktop-v1.") ? "desktop" : "stdio";
}
export function encodeModel(model: NativeModel, backend = "stdio"): HarnessModelRef {
  return harnessModelRefSchema.parse({
    id: `${backend === "desktop" ? "zcode-desktop-v1." : "zcode-v1."}${Buffer.from(JSON.stringify([model.providerId, model.modelId])).toString("base64url")}`,
  });
}
export function decodeModel(model: HarnessModelRef): NativeModel {
  try {
    const backend = modelBackend(model),
      prefix = backend === "desktop" ? "zcode-desktop-v1." : "zcode-v1.";
    const value: unknown = JSON.parse(
      Buffer.from(model.id.slice(prefix.length), "base64url").toString("utf8"),
    );
    if (!model.id.startsWith(prefix) || !Array.isArray(value) || value.length !== 2)
      throw new Error();
    const native = nativeModelSchema.parse({ providerId: value[0], modelId: value[1] });
    if (encodeModel(native, backend).id !== model.id) throw new Error();
    return native;
  } catch {
    throw new ZcodeError("invalidRequest", "Invalid ZCode model reference");
  }
}
/** Process-registry model selection includes its native reasoning option in the same request. */
export function selectNativeModel(
  model: HarnessModelRef,
  settings: NativeSettings,
  processRegistry: boolean,
  thinkingOption?: string,
): NativeModel {
  const native = decodeModel(model);
  if (!processRegistry) return native;
  const backend = modelBackend(model);
  const entry = settings.model.available.find(
    (entry) => encodeModel(entry.ref, backend).id === model.id,
  );
  const reasoning = entry?.reasoning;
  if (!reasoning?.enabled || !reasoning.levels.length) return native;
  const current = settings.model.current;
  const previous =
    current && encodeModel(current, backend).id === model.id
      ? (current.options?.reasoningLevel ?? settings.thoughtLevel.current)
      : undefined;
  const level =
    thinkingOption ??
    previous ??
    reasoning.defaultLevel ??
    (reasoning.levels.length === 1 ? reasoning.levels[0]?.value : undefined);
  if (!level || !reasoning.levels.some((option) => option.value === level))
    throw new ZcodeError(
      "invalidRequest",
      "ZCode did not provide a supported default reasoning level for this model",
    );
  return { ...native, options: { reasoningLevel: level } };
}

export function modelCatalog(settings: NativeSettings, backend = "stdio") {
  const available = settings.model.available.filter((model) => !model.disabledReason);
  const levels = new Map(settings.thoughtLevel.available.map((level) => [level.value, level]));
  for (const model of available)
    for (const level of model.reasoning?.levels ?? []) levels.set(level.value, level);
  const current = settings.model.current ? encodeModel(settings.model.current, backend) : undefined;
  const defaultThinking = settings.thoughtLevel.current ?? settings.thoughtLevel.defaultLevel;
  return harnessModelCatalogSchema.parse({
    models: available.map((model) => ({
      ref: encodeModel(model.ref, backend),
      label: model.label,
      supportedThinkingOptionIds: model.reasoning?.enabled
        ? model.reasoning.levels.map((level) => level.value)
        : [],
    })),
    ...(current && available.some((model) => encodeModel(model.ref, backend).id === current.id)
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
  const settings = snapshot.settings,
    backend = locator?.backend === "desktop" ? "desktop" : "stdio";
  const current = settings.model.current ? encodeModel(settings.model.current, backend) : undefined;
  const model = settings.model.available.find(
    (candidate) => encodeModel(candidate.ref, backend).id === current?.id,
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
export function contextUsage(snapshot: NativeSnapshot): HostUsage | null {
  return snapshot.projection.contextWindow > 0
    ? parseHostUsage({
        contextUsedTokens: snapshot.projection.contextUsed,
        contextWindowTokens: snapshot.projection.contextWindow,
      })
    : null;
}
