import {
  catalogModelForRef,
  harnessModelRefSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

import { DelegationControlError } from "./delegation-types.js";

const tierSuffix = /~(fast|ultrafast)$/u;

export function formatDelegationModel(ref: HarnessModelRef): string {
  if (ref.serviceTier === "priority") return `${ref.id}~fast`;
  if (ref.serviceTier === "ultrafast") return `${ref.id}~ultrafast`;
  return ref.id;
}

export async function resolveDelegationModelArgument(
  input: string | HarnessModelRef,
  inspectCatalog: () => Promise<HarnessModelCatalog | undefined>,
): Promise<HarnessModelRef> {
  if (typeof input === "string") {
    const suffix = tierSuffix.exec(input);
    if (suffix) {
      const candidate = harnessModelRefSchema.safeParse({
        id: input.slice(0, suffix.index),
        serviceTier: suffix[1] === "fast" ? "priority" : "ultrafast",
      });
      if (candidate.success && catalogModelForRef(await inspectCatalog(), candidate.data))
        return candidate.data;
    }
  }
  const ref = harnessModelRefSchema.safeParse(typeof input === "string" ? { id: input } : input);
  if (!ref.success) throw new DelegationControlError("INVALID_ARGUMENT", "Model is invalid");
  return ref.data;
}
