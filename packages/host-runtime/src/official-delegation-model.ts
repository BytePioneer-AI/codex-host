import {
  harnessModelRefIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

import { DelegationControlError } from "./delegation-types.js";
import {
  canonicalizeOfficialCodexModelRef,
  decodeOfficialCodexModelSelection,
  encodeOfficialCodexModelRef,
} from "./official-codex-model-ref.js";

const tierSuffix = /~(fast|ultrafast)$/u;

function advertisedTierRef(
  nativeId: string,
  suffix: RegExpExecArray,
  catalog: HarnessModelCatalog | undefined,
): HarnessModelRef | undefined {
  const base = nativeId.slice(0, suffix.index);
  const tier = suffix[1] === "fast" ? "priority" : "ultrafast";
  for (const entry of catalog?.models ?? []) {
    const ref = tier === "priority" ? entry.fastModel : entry.ref;
    if (!ref) continue;
    const selection = decodeOfficialCodexModelSelection(ref);
    if (selection.model === base && selection.serviceTier === tier) return ref;
  }
  return undefined;
}

export function formatOfficialDelegationModel(
  ref: HarnessModelRef,
  catalog?: HarnessModelCatalog,
): string {
  const { model, serviceTier } = decodeOfficialCodexModelSelection(ref);
  if (/^(?:--|codex-(?:model|fast-model|ultra)-v1\.)|[\r\n\u2028\u2029]/u.test(model))
    return ref.id;
  if (serviceTier !== null) return `${model}~${serviceTier === "priority" ? "fast" : "ultrafast"}`;
  const suffix = tierSuffix.exec(model);
  return suffix && (!catalog || advertisedTierRef(model, suffix, catalog)) ? ref.id : model;
}

export async function resolveOfficialDelegationModel(
  id: string,
  inspectCatalog: () => Promise<HarnessModelCatalog | undefined>,
): Promise<HarnessModelRef> {
  if (typeof id !== "string") {
    throw new DelegationControlError("INVALID_ARGUMENT", "Official Model is invalid");
  }
  const suffix = tierSuffix.exec(id);
  if (suffix) {
    const ref = advertisedTierRef(id, suffix, await inspectCatalog());
    if (ref) return ref;
  }
  try {
    const parsed = harnessModelRefIdSchema.safeParse(id);
    return parsed.success
      ? canonicalizeOfficialCodexModelRef({ id: parsed.data })
      : encodeOfficialCodexModelRef(id);
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Official Model is invalid");
  }
}
