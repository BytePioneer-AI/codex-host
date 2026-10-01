import fs from "node:fs";
import path from "node:path";
import type { ModelInfo, PermissionRuleset, SessionInfo } from "@opencode/client";
import {
  parseHostUsage,
  type HarnessError,
  type HarnessExecutionPolicy,
  type HarnessSessionState,
} from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessIdSchema,
  harnessModelCatalogSchema,
  nativeSessionRefSchema,
  type HarnessModelCatalog,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { decodeOpenCodePermissionModeId } from "../permission-modes.js";
import { encodeOpenCodeModelRef, encodeOpenCodeVariant } from "../model-catalog.js";

export const harnessId = harnessIdSchema.parse("opencode");
export function failure(
  message: string,
  code: HarnessError["code"] = "nativeFailure",
): HarnessError {
  return {
    code,
    message,
    retryable: ["nativeFailure", "unavailable", "sessionBusy"].includes(code),
  };
}
export function errorResult(error: unknown) {
  return {
    ok: false as const,
    error: failure(error instanceof Error ? error.message : String(error)),
  };
}
export function sameDirectory(left: string, right: string) {
  const canonical = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(left) === canonical(right);
}
export function v2Ref(
  session: SessionInfo,
  executionPolicy: HarnessExecutionPolicy,
): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    harnessId,
    nativeSessionId: session.id,
    formatVersion: 1,
    locator: { protocol: 2, directory: session.location.directory, executionPolicy },
  });
}
export function v2Locator(ref: NativeSessionRef): {
  directory: string;
  executionPolicy: HarnessExecutionPolicy;
} {
  nativeSessionRefSchema.parse(ref);
  const locator = ref.locator;
  if (
    ref.harnessId !== harnessId ||
    !locator ||
    typeof locator !== "object" ||
    Array.isArray(locator) ||
    locator.protocol !== 2 ||
    typeof locator.directory !== "string" ||
    !locator.directory ||
    (locator.executionPolicy !== "default" && locator.executionPolicy !== "unattended-full-access")
  ) {
    throw new Error(
      "This Session requires an OpenCode v2 Native Ref; v1 histories are not migrated by codexhost",
    );
  }
  return { directory: locator.directory, executionPolicy: locator.executionPolicy };
}
export function v2Catalog(
  models: ModelInfo[],
  defaultModel: ModelInfo | null,
): HarnessModelCatalog {
  const enabled = models.filter((model) => model.enabled);
  const variants = [...new Set(enabled.flatMap((model) => model.variants.map((v) => v.id)))].sort();
  const ref = (model: ModelInfo) =>
    encodeOpenCodeModelRef({ providerID: model.providerID, modelID: model.id });
  return harnessModelCatalogSchema.parse({
    models: enabled.map((model) => ({
      ref: ref(model),
      label: `${model.providerID} / ${model.name}`,
      resolvedModelLabel: `${model.providerID}/${model.id}`,
      supportedThinkingOptionIds: [
        encodeOpenCodeVariant(undefined),
        ...model.variants.map((v) => encodeOpenCodeVariant(v.id)),
      ],
    })),
    ...(defaultModel && enabled.some((m) => ref(m).id === ref(defaultModel).id)
      ? { defaultModel: ref(defaultModel) }
      : {}),
    thinkingOptions: [undefined, ...variants].map((v) => ({
      id: encodeOpenCodeVariant(v),
      label: v ?? "Default",
    })),
    defaultThinkingOptionId: encodeOpenCodeVariant(undefined),
  });
}
export function v2Permissions(
  current: PermissionRuleset = [],
  mode: Parameters<typeof decodeOpenCodePermissionModeId>[0],
): PermissionRuleset {
  const selected = decodeOpenCodePermissionModeId(mode);
  const rules = current.filter(
    (rule) =>
      !(rule.action === "*" && rule.resource === "*" && ["allow", "ask"].includes(rule.effect)),
  );
  return selected === "default"
    ? rules
    : [...rules, { action: "*", resource: "*", effect: selected }];
}
export function v2State(
  session: SessionInfo,
  catalog: HarnessModelCatalog,
  policy: HarnessExecutionPolicy,
): HarnessSessionState {
  const model = session.model
    ? encodeOpenCodeModelRef({ providerID: session.model.providerID, modelID: session.model.id })
    : undefined;
  const entry = catalog.models.find((candidate) => candidate.ref.id === model?.id);
  const mode = session.permissions?.findLast(
    (rule) => rule.action === "*" && rule.resource === "*",
  );
  return {
    nativeRef: v2Ref(session, policy),
    ...(model ? { effectiveModel: model } : {}),
    ...(entry
      ? {
          resolvedModelLabel: entry.resolvedModelLabel ?? entry.label,
          availableThinkingOptions: catalog.thinkingOptions.filter((v) =>
            entry.supportedThinkingOptionIds?.includes(v.id),
          ),
          effectiveThinkingOptionId: encodeOpenCodeVariant(session.model?.variant),
        }
      : {}),
    effectivePermissionModeId: decodeMode(mode?.effect),
  };
}
function decodeMode(effect?: string) {
  return effect === "allow" || effect === "ask"
    ? harnessPermissionModeIdSchema.parse(effect)
    : harnessPermissionModeIdSchema.parse("default");
}

export function v2Usage(session: SessionInfo) {
  const tokens = session.tokens;
  return parseHostUsage({
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningOutputTokens: tokens.reasoning,
    cachedInputTokens: tokens.cache.read,
    cacheWriteInputTokens: tokens.cache.write,
    totalCostUsd: session.cost,
  });
}
