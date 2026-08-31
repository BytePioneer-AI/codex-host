import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelRefSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export const OFFICIAL_CODEX_MODEL_REF_PREFIX = "codex-model-v1.";

export function encodeOfficialCodexModelRef(nativeModelId: string): HarnessModelRef {
  if (!nativeModelId.trim()) throw new Error("Official Codex Model id must not be empty");
  const encoded = Buffer.from(nativeModelId, "utf8").toString("base64url");
  const id = `${OFFICIAL_CODEX_MODEL_REF_PREFIX}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Official Codex Model id is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeOfficialCodexModelRef(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  if (!parsed.id.startsWith(OFFICIAL_CODEX_MODEL_REF_PREFIX)) {
    return parsed.id;
  }
  const encoded = parsed.id.slice(OFFICIAL_CODEX_MODEL_REF_PREFIX.length);
  if (!encoded) throw new Error("Official Codex Model Ref is empty");
  const nativeModelId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!nativeModelId.trim()) throw new Error("Official Codex Model Ref is malformed");
  if (encodeOfficialCodexModelRef(nativeModelId).id !== parsed.id) {
    throw new Error("Official Codex Model Ref is not canonical");
  }
  return nativeModelId;
}

export function canonicalizeOfficialCodexModelRef(ref: HarnessModelRef): HarnessModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  try {
    return encodeOfficialCodexModelRef(decodeOfficialCodexModelRef(parsed));
  } catch {
    return encodeOfficialCodexModelRef(parsed.id);
  }
}
