import type { ModelPriceSuggestion } from "@codexhost/shared-contracts";
import type { ModelPriceTableData } from "./model-prices.js";

function modelWords(value: string): string[] {
  return value
    .slice(value.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/([a-z])(\d)/gu, "$1-$2")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/** Only catalog links establish identity; neither similar names nor equal prices do. */
function canonicalModel(table: ModelPriceTableData, start: string): string | undefined {
  const seen = new Set<string>();
  let id = start;
  while (!seen.has(id)) {
    seen.add(id);
    const slash = id.indexOf("/");
    const next = table.providers[id.slice(0, slash)]?.[id.slice(slash + 1)]?.[4];
    if (next === true || next === id) return id;
    if (typeof next !== "string") return id === start ? undefined : id;
    if (!next.includes("/") || next.startsWith("/") || next.endsWith("/")) return undefined;
    id = next;
  }
  return undefined; // A cyclic chain cannot establish an official identity.
}

const qualifiers = new Set(["free", "preview", "latest", "beta", "auto", "model"]);

/** Suggestions only; independent of automatic price lookup and user overrides. */
export function suggestModelPrices(
  query: string,
  table: ModelPriceTableData,
): ModelPriceSuggestion[] {
  const slash = query.indexOf("/");
  const requestedProvider =
    slash > 0 && Object.hasOwn(table.providers, query.slice(0, slash))
      ? query.slice(0, slash)
      : null;
  const queryWords = modelWords(query);
  const baseWords = queryWords.at(-1) === "free" ? queryWords.slice(0, -1) : queryWords;
  const querySet = new Set(baseWords);
  const distinctive = queryWords.filter((word) => /[a-z]/u.test(word) && !qualifiers.has(word));
  if (!distinctive.length) return [];
  const related = new Map<string, number>();
  const entries: Array<{ suggestion: ModelPriceSuggestion; score: number }> = [];
  for (const [provider, models] of Object.entries(table.providers)) {
    for (const [model, entry] of Object.entries(models)) {
      const candidateWords = modelWords(model);
      const candidate = new Set(candidateWords);
      const overlap = [...querySet].filter((word) => candidate.has(word)).length;
      const similarity = (2 * overlap) / (querySet.size + candidate.size);
      const exact = queryWords.join("") === candidateWords.join("");
      const baseExact =
        baseWords.length !== queryWords.length && baseWords.join("") === candidateWords.join("");
      const score =
        similarity >= 0.6 && distinctive.some((word) => candidate.has(word))
          ? similarity + (baseExact ? 2 : exact ? 1 : 0)
          : 0;
      const canonicalModelId = canonicalModel(table, `${provider}/${model}`);
      const official = canonicalModelId?.slice(0, canonicalModelId.indexOf("/")) === provider;
      if (canonicalModelId && (exact || baseExact) && score > 0)
        related.set(canonicalModelId, Math.max(score, related.get(canonicalModelId) ?? 0));
      const [input, output, cacheRead, cacheWrite] = entry;
      entries.push({
        score,
        suggestion: {
          provider,
          model,
          ...(canonicalModelId ? { canonicalModelId } : {}),
          ...(official ? { official: true } : {}),
          price: {
            input,
            output,
            ...(cacheRead != null ? { cacheRead } : {}),
            ...(cacheWrite != null ? { cacheWrite } : {}),
          },
        },
      });
    }
  }
  // Include differently named aliases of strong matches, with each listing's own price.
  for (const row of entries) {
    const id = row.suggestion.canonicalModelId;
    if (id) row.score = Math.max(row.score, related.get(id) ?? 0);
  }
  const ranked = entries
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.suggestion.provider === requestedProvider) -
          Number(a.suggestion.provider === requestedProvider) ||
        Number(b.suggestion.official === true) - Number(a.suggestion.official === true) ||
        a.suggestion.model.localeCompare(b.suggestion.model) ||
        a.suggestion.provider.localeCompare(b.suggestion.provider),
    );
  // Preserve distinct model IDs, including aliases with identical prices. Bound only
  // repeated listings of the exact same ID; official listings never lose to resellers.
  const counts = new Map<string, number>();
  const result: ModelPriceSuggestion[] = [];
  for (const { suggestion } of ranked) {
    const count = counts.get(suggestion.model) ?? 0;
    if (!suggestion.official && count >= 2) continue;
    counts.set(suggestion.model, count + 1);
    result.push(suggestion);
    if (result.length === 6) break;
  }
  return result;
}
