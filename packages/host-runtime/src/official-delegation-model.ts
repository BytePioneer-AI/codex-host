import {
  catalogModelForRef,
  sameHarnessModelRef,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

import { resolveDelegationModelArgument } from "./delegation-model-argument.js";
import { normalizeOfficialCodexModelRef } from "./official-codex-model-ref.js";

export async function resolveOfficialDelegationModel(
  input: string | HarnessModelRef,
  inspectCatalog: () => Promise<HarnessModelCatalog | undefined>,
): Promise<HarnessModelRef> {
  const ref = await resolveDelegationModelArgument(input, inspectCatalog);
  const normalized = normalizeOfficialCodexModelRef(ref);
  return !sameHarnessModelRef(ref, normalized) && catalogModelForRef(await inspectCatalog(), ref)
    ? ref
    : normalized;
}
