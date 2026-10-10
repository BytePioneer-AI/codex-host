import type { HarnessModelRef } from "@codexhost/shared-contracts";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";

export function isHermesModeId(value: string): value is "default" | "dont_ask" {
  return value === "default" || value === "dont_ask";
}

/**
 * Native Hermes model ids look like `zai:glm-5-turbo` (contain `:`), which
 * the transport-safe HarnessModelRef regex rejects. Model refs are opaque to
 * the Host, so encode the native id reversibly (base64url) inside the ref id.
 */
export function encodeHermesModelRef(modelId: string): HarnessModelRef | null {
  const ref = harnessModelRefSchema.safeParse({
    id: Buffer.from(modelId, "utf8").toString("base64url"),
  });
  return ref.success ? ref.data : null;
}

export function decodeHermesModelRefId(modelRefId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(modelRefId)) return null;
  try {
    const decoded = Buffer.from(modelRefId, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
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
    effectiveModel: encodeHermesModelRef(current.modelId),
    resolvedModelLabel: catalogAlignedModelLabel(current.name),
  };
}
