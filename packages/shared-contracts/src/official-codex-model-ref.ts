import {
  HARNESS_MODEL_REF_MAX_LENGTH,
  harnessModelRefSchema,
  type HarnessModelRef,
} from "./harness-models.js";

export const OFFICIAL_CODEX_MODEL_REF_PREFIX = "codex-model-v1.";

const modelRefPrefixes = [
  ["codex-fast-model-v1.", "priority"],
  ["codex-ultra-v1.", "ultrafast"],
  [OFFICIAL_CODEX_MODEL_REF_PREFIX, null],
] as const;

export function encodeOfficialCodexModelRef(
  nativeModelId: string,
  serviceTier?: string | null,
): HarnessModelRef {
  if (!nativeModelId.trim()) throw new Error("Official Codex Model id must not be empty");
  if (nativeModelId.length > HARNESS_MODEL_REF_MAX_LENGTH)
    throw new Error("Official Codex Model id is too long for a Model Ref");
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(nativeModelId)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
  const prefix =
    modelRefPrefixes.find(([, tier]) => tier === serviceTier)?.[0] ??
    OFFICIAL_CODEX_MODEL_REF_PREFIX;
  const id = `${prefix}${encoded}`;
  if (id.length > HARNESS_MODEL_REF_MAX_LENGTH) {
    throw new Error("Official Codex Model id is too long for a Model Ref");
  }
  return harnessModelRefSchema.parse({ id });
}

export function decodeOfficialCodexModelRef(ref: HarnessModelRef): string {
  return decodeOfficialCodexModelSelection(ref).model;
}

/** Ordinary selections explicitly clear the tier; omitted selections preserve native settings. */
export function decodeOfficialCodexModelSelection(ref: HarnessModelRef): {
  model: string;
  serviceTier: (typeof modelRefPrefixes)[number][1];
} {
  const parsed = harnessModelRefSchema.parse(ref);
  const match = modelRefPrefixes.find(([prefix]) => parsed.id.startsWith(prefix));
  if (!match) return { model: parsed.id, serviceTier: null };
  const [prefix, serviceTier] = match;
  const encoded = parsed.id.slice(prefix.length);
  if (!encoded) throw new Error("Official Codex Model Ref is empty");
  let nativeModelId: string;
  try {
    nativeModelId = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/")), (char) =>
        char.charCodeAt(0),
      ),
    );
  } catch {
    throw new Error("Official Codex Model Ref is not canonical");
  }
  if (!nativeModelId.trim()) throw new Error("Official Codex Model Ref is malformed");
  if (encodeOfficialCodexModelRef(nativeModelId, serviceTier).id !== parsed.id) {
    throw new Error("Official Codex Model Ref is not canonical");
  }
  return { model: nativeModelId, serviceTier };
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
