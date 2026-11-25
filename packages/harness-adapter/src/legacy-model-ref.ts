import { Buffer } from "node:buffer";

import type { HarnessModelCatalog, HarnessModelRef } from "@codexhost/shared-contracts";

export function normalizeLegacyBase64ModelRef(
  ref: HarnessModelRef,
  catalog: HarnessModelCatalog,
  prefix: string,
): HarnessModelRef | undefined {
  if (ref.serviceTier || !ref.id.startsWith(prefix)) return undefined;
  const encoded = ref.id.slice(prefix.length);
  const id = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(id).toString("base64url") !== encoded) return undefined;
  return catalog.models.find(({ ref }) => ref.id === id && !ref.serviceTier)?.ref;
}
