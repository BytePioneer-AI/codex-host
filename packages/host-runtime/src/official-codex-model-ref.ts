import { Buffer } from "node:buffer";

import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelRefSchema,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export const OFFICIAL_CODEX_MODEL_REF_PREFIX = "codex-model-v1.";

const OFFICIAL_CODEX_FAST_MODEL_REF_PREFIX = "codex-fast-model-v1.";

export function encodeOfficialCodexModelRef(
  nativeModelId: string,
  serviceTier?: string | null,
): HarnessModelRef {
  if (!nativeModelId.trim()) throw new Error("Official Codex Model id must not be empty");
  const encoded = Buffer.from(nativeModelId, "utf8").toString("base64url");
  const prefix =
    serviceTier === "priority"
      ? OFFICIAL_CODEX_FAST_MODEL_REF_PREFIX
      : OFFICIAL_CODEX_MODEL_REF_PREFIX;
  const id = `${prefix}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Official Codex Model id is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeOfficialCodexModelRef(ref: HarnessModelRef): string {
  const parsed = harnessModelRefSchema.parse(ref);
  const fast = parsed.id.startsWith(OFFICIAL_CODEX_FAST_MODEL_REF_PREFIX);
  const prefix = fast ? OFFICIAL_CODEX_FAST_MODEL_REF_PREFIX : OFFICIAL_CODEX_MODEL_REF_PREFIX;
  if (!parsed.id.startsWith(prefix)) return parsed.id;
  const encoded = parsed.id.slice(prefix.length);
  if (!encoded) throw new Error("Official Codex Model Ref is empty");
  const nativeModelId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!nativeModelId.trim()) throw new Error("Official Codex Model Ref is malformed");
  if (encodeOfficialCodexModelRef(nativeModelId, fast ? "priority" : null).id !== parsed.id) {
    throw new Error("Official Codex Model Ref is not canonical");
  }
  return nativeModelId;
}

/** Ordinary selections explicitly clear Fast; omitted selections preserve native settings. */
export function decodeOfficialCodexModelSelection(ref: HarnessModelRef): {
  model: string;
  serviceTier: "priority" | null;
} {
  return {
    model: decodeOfficialCodexModelRef(ref),
    serviceTier: ref.id.startsWith(OFFICIAL_CODEX_FAST_MODEL_REF_PREFIX) ? "priority" : null,
  };
}

export function canonicalizeOfficialCodexModelRef(ref: HarnessModelRef): HarnessModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  try {
    const selection = decodeOfficialCodexModelSelection(parsed);
    return encodeOfficialCodexModelRef(selection.model, selection.serviceTier);
  } catch {
    return encodeOfficialCodexModelRef(parsed.id);
  }
}
