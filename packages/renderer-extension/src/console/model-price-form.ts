import type { ModelPriceOverride, ModelPriceOverridesSet } from "@codexhost/shared-contracts";

export const MODEL_PRICE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const satisfies readonly (keyof ModelPriceOverride)[];

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

export type ModelPriceField = (typeof MODEL_PRICE_FIELDS)[number];

/** The editor's text, before validation. An empty price is "not set", never 0. */
export interface ModelPriceDraft {
  model: string;
  prices: Record<ModelPriceField, string>;
}

export type ModelPriceDraftError =
  | { kind: "modelRequired" }
  | { kind: "duplicate"; key: string }
  | { kind: "priceRequired"; field: ModelPriceField }
  | { kind: "priceInvalid"; field: ModelPriceField };

export function modelPriceDraft(key: string, price: ModelPriceOverride | null): ModelPriceDraft {
  const prices = Object.fromEntries(
    MODEL_PRICE_FIELDS.map((field) => [field, price?.[field]?.toString() ?? ""]),
  ) as Record<ModelPriceField, string>;
  return { model: key, prices };
}

/**
 * Validates the editor into one `pricing.json` change. `previousKey` is the edited entry, if
 * any; `existingKeys` are the keys already configured.
 */
export function modelPriceChange(
  draft: ModelPriceDraft,
  existingKeys: readonly string[],
  previousKey?: string,
): { change: ModelPriceOverridesSet } | { error: ModelPriceDraftError } {
  const key = draft.model.trim();
  if (!key) return { error: { kind: "modelRequired" } };
  if (key !== previousKey && existingKeys.includes(key)) {
    return { error: { kind: "duplicate", key } };
  }
  const price: Partial<ModelPriceOverride> = {};
  for (const field of MODEL_PRICE_FIELDS) {
    const text = draft.prices[field].trim();
    if (text === "") {
      if (field === "input" || field === "output")
        return { error: { kind: "priceRequired", field } };
      continue;
    }
    const value = Number(text);
    // Plain decimals (as JSON writes them): no signs, hex or Infinity.
    if (!DECIMAL.test(text) || !Number.isFinite(value)) {
      return { error: { kind: "priceInvalid", field } };
    }
    price[field] = value;
  }
  return {
    change: {
      key,
      price: price as ModelPriceOverride,
      ...(previousKey !== undefined ? { previousKey } : {}),
    },
  };
}
