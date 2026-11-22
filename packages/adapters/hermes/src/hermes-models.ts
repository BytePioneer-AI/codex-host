import { normalizeLegacyBase64ModelRef } from "@codexhost/harness-adapter";
import type { HarnessModelCatalog, HarnessModelRef } from "@codexhost/shared-contracts";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";

export function isHermesModeId(value: string): value is "default" | "dont_ask" {
  return value === "default" || value === "dont_ask";
}

export function hermesModelRef(id: string): HarnessModelRef | null {
  return harnessModelRefSchema.safeParse({ id }).data ?? null;
}

export function normalizeStoredHermesModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
): HarnessModelRef | undefined {
  return normalizeLegacyBase64ModelRef(ref, catalog, "");
}

export interface HermesSessionModelStateProjection {
  effectiveModel: HarnessModelRef | null;
  resolvedModelLabel: string | null;
}

interface HermesModelChoice {
  modelId: string;
  name: string;
}

/**
 * Native model labels may use `{provider} · {model}` while the
 * inventory catalog renders `{provider} / {model}`. The Host picker treats a
 * differing resolved label as an alias route worth surfacing next to the
 * selected entry, so normalize the native separator to keep one spelling.
 */
export function catalogAlignedModelLabel(name: string): string {
  return name.replace(/\s+·\s+/g, " / ");
}

export function projectHermesModelState(
  models: { availableModels: HermesModelChoice[]; currentModelId?: string } | null,
): HermesSessionModelStateProjection {
  if (!models || models.availableModels.length === 0) {
    return { effectiveModel: null, resolvedModelLabel: null };
  }
  const current = models.currentModelId
    ? models.availableModels.find(({ modelId }) => modelId === models.currentModelId)
    : undefined;
  if (!current) return { effectiveModel: null, resolvedModelLabel: null };
  return {
    effectiveModel: hermesModelRef(current.modelId),
    resolvedModelLabel: catalogAlignedModelLabel(current.name),
  };
}
