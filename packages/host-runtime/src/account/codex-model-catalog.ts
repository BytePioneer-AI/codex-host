import { readFileSync } from "node:fs";

export interface BundledModelCatalog {
  readonly json: string;
  readonly patchedModels: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve model capabilities and metadata; extend only the advertised request tiers. */
export function extendModelCatalog(source: string): BundledModelCatalog {
  const catalog: unknown = JSON.parse(source);
  if (!isRecord(catalog) || !Array.isArray(catalog.models) || !catalog.models.length) {
    throw new Error("The model catalog has no models");
  }
  const models = catalog.models.map((model: unknown) => {
    if (!isBundledModel(model)) throw new Error("The model catalog contains an invalid model");
    const tiers: unknown[] = Array.isArray(model.service_tiers) ? [...model.service_tiers] : [];
    for (const [id, name] of [
      ["priority", "Fast"],
      ["ultrafast", "Ultrafast"],
    ]) {
      if (!tiers.some((tier) => isRecord(tier) && tier.id === id)) {
        tiers.push({ id, name, description: "" });
      }
    }
    return { ...model, service_tiers: tiers };
  });
  return { json: JSON.stringify({ ...catalog, models }), patchedModels: models.length };
}

/** Extract the installed CLI's catalog, without replacing its executable or guessing models. */
export function readBundledModelCatalog(codexExecutable: string): BundledModelCatalog {
  const bytes = readFileSync(codexExecutable);
  const source = bytes.toString("latin1");
  const marker = '"slug":';
  const models: unknown[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf(marker, cursor);
    if (at < 0) break;
    cursor = at + marker.length;
    const start = source.lastIndexOf("{", at);
    if (start < 0) continue;
    const end = matchingBrace(source, start);
    if (end < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(start, end + 1).toString("utf8"));
    } catch {
      continue;
    }
    if (!isBundledModel(parsed) || seen.has(parsed.slug)) continue;
    seen.add(parsed.slug);
    models.push(parsed);
  }
  return extendModelCatalog(JSON.stringify({ models }));
}

function isBundledModel(value: unknown): value is { slug: string } & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.slug === "string" &&
    value.slug.length > 0 &&
    Array.isArray(value.supported_reasoning_levels)
  );
}

function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
