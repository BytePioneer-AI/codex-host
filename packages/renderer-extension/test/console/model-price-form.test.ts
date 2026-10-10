import { describe, expect, it } from "vitest";

import {
  modelPriceChange,
  modelPriceDraft,
  type ModelPriceDraft,
} from "../../src/console/model-price-form.js";

function draft(
  overrides: Omit<Partial<ModelPriceDraft>, "prices"> & {
    prices?: Partial<ModelPriceDraft["prices"]>;
  },
): ModelPriceDraft {
  return {
    model: "my-model",
    ...overrides,
    prices: {
      input: "0.5",
      output: "1.5",
      cacheRead: "",
      cacheWrite: "",
      ...overrides.prices,
    },
  };
}

describe("model price form", () => {
  it("keeps unset prices absent and an explicit 0 as 0", () => {
    expect(modelPriceChange(draft({ prices: { cacheRead: "0" } }), [])).toEqual({
      change: { key: "my-model", price: { input: 0.5, output: 1.5, cacheRead: 0 } },
    });
  });

  it("trims the model ID and edits or renames an existing key", () => {
    expect(modelPriceChange(draft({ model: " m " }), [])).toEqual({
      change: { key: "m", price: { input: 0.5, output: 1.5 } },
    });
    expect(modelPriceChange(draft({}), ["my-model", "x"], "my-model")).toMatchObject({
      change: { key: "my-model", previousKey: "my-model" },
    });
    expect(modelPriceChange(draft({ model: "x" }), ["my-model", "x"], "my-model")).toEqual({
      error: { kind: "duplicate", key: "x" },
    });
    expect(modelPriceChange(draft({}), ["my-model"])).toEqual({
      error: { kind: "duplicate", key: "my-model" },
    });
  });

  it.each([
    [{ model: " " }, { kind: "modelRequired" }],
    [{ prices: { output: "" } }, { kind: "priceRequired", field: "output" }],
    [{ prices: { input: "-1" } }, { kind: "priceInvalid", field: "input" }],
    [{ prices: { cacheWrite: "abc" } }, { kind: "priceInvalid", field: "cacheWrite" }],
    [{ prices: { cacheWrite: "Infinity" } }, { kind: "priceInvalid", field: "cacheWrite" }],
    [{ prices: { cacheRead: "0x10" } }, { kind: "priceInvalid", field: "cacheRead" }],
  ] as const)("rejects %j", (overrides, error) => {
    expect(modelPriceChange(draft(overrides), [])).toEqual({ error });
  });

  it("round-trips a stored key and its prices, including IDs with '/'", () => {
    const value = modelPriceDraft("openrouter/anthropic/claude", {
      input: 3,
      output: 15,
      cacheRead: 0,
    });
    expect(value).toEqual({
      model: "openrouter/anthropic/claude",
      prices: { input: "3", output: "15", cacheRead: "0", cacheWrite: "" },
    });
    expect(
      modelPriceChange(value, ["openrouter/anthropic/claude"], "openrouter/anthropic/claude"),
    ).toEqual({
      change: {
        key: "openrouter/anthropic/claude",
        previousKey: "openrouter/anthropic/claude",
        price: { input: 3, output: 15, cacheRead: 0 },
      },
    });
  });

  it("round-trips Object.prototype names as ordinary keys", () => {
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(modelPriceChange(modelPriceDraft(key, { input: 1, output: 1 }), [key], key)).toEqual({
        change: { key, previousKey: key, price: { input: 1, output: 1 } },
      });
      expect(modelPriceChange(draft({ model: key }), ["other"])).toMatchObject({ change: { key } });
      expect(modelPriceChange(draft({ model: key }), [key])).toEqual({
        error: { kind: "duplicate", key },
      });
    }
  });
});
