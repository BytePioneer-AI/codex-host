import {
  harnessModelRefSchema,
  harnessModelServiceTierSchema,
  type HarnessModelRef,
  type HarnessModelServiceTier,
} from "./harness-models.js";

const legacyPrefixes = [
  ["codex-fast-model-v1.", "priority"],
  ["codex-ultra-v1.", "ultrafast"],
  ["codex-model-v1.", undefined],
] as const;

export function officialCodexModelRef(id: string, serviceTier?: string | null): HarnessModelRef {
  const tier = harnessModelServiceTierSchema.safeParse(serviceTier);
  return harnessModelRefSchema.parse({ id, ...(tier.success ? { serviceTier: tier.data } : {}) });
}

export function normalizeOfficialCodexModelRef(ref: HarnessModelRef): HarnessModelRef {
  const parsed = harnessModelRefSchema.parse(ref);
  if (parsed.serviceTier !== undefined) return parsed;
  const match = legacyPrefixes.find(([prefix]) => parsed.id.startsWith(prefix));
  if (!match) return parsed;
  const [prefix, tier] = match;
  const encoded = parsed.id.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return parsed;
  try {
    const bytes = atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/"));
    if (btoa(bytes).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "") !== encoded)
      return parsed;
    const id = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(bytes, (char) => char.charCodeAt(0)),
    );
    return officialCodexModelRef(id, tier);
  } catch {
    return parsed;
  }
}

export function officialCodexModelSelection(ref: HarnessModelRef): {
  model: string;
  serviceTier: HarnessModelServiceTier | null;
} {
  return { model: ref.id, serviceTier: ref.serviceTier ?? null };
}
