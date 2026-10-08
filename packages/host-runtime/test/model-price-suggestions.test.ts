import { expect, it } from "vitest";
import { suggestModelPrices } from "../src/model-price-suggestions.js";
import { ModelPriceLookup, type ModelPriceTableData } from "../src/model-prices.js";

const table: ModelPriceTableData = {
  fetchedAtMs: 1,
  providers: {
    vendor: {
      "deepseek-v4-flash": [1, 2, 0, null, true],
      "deepseek-v4-pro": [5, 10],
      "deepseek-v3-flash": [3, 4],
      "unrelated-free": [0, 0],
    },
    reseller: { "deepseek-v4-flash": [9, 10, null, 11] },
  },
};

it("ranks name tokens case-insensitively without automatically pricing aliases", () => {
  const result = suggestModelPrices("DEEPSEEK_v4_flash_free", table);
  expect(result[0]).toEqual({
    provider: "vendor",
    model: "deepseek-v4-flash",
    official: true,
    canonicalModelId: "vendor/deepseek-v4-flash",
    price: { input: 1, output: 2, cacheRead: 0 },
  });
  expect(result.some((row) => row.model === "unrelated-free")).toBe(false);
  expect(new ModelPriceLookup(table).find("DEEPSEEK_v4_flash_free")).toBeNull();
});
it("puts the base model before free aliases, including provider-prefixed IDs", () => {
  const withFree: ModelPriceTableData = {
    fetchedAtMs: 1,
    providers: {
      ...table.providers,
      free1: { "deepseek-v4-flash-free": [0, 0] },
      free2: { "deepseek-v4-flash:free": [0, 0] },
      free3: { "deepseek/deepseek-v4-flash-free": [0, 0] },
      free4: { "another/deepseek-v4-flash:free": [0, 0] },
    },
  };
  for (const query of [
    "deepseek-v4-flash-free",
    "deepseek-v4-flash:free",
    "deepseek/deepseek-v4-flash-free",
  ]) {
    const rows = suggestModelPrices(query, withFree);
    expect(rows[0]).toMatchObject({
      provider: "vendor",
      model: "deepseek-v4-flash",
      price: { input: 1, output: 2 },
    });
    expect(rows.slice(0, 2).every((row) => row.model === "deepseek-v4-flash")).toBe(true);
    expect(rows.some((row) => row.price.input === 0 && row.price.output === 0)).toBe(true);
    expect(rows.filter((row) => /free$/u.test(row.model))).toHaveLength(4);
  }
});

it("does not strip version or capability suffixes as if they were free tiers", () => {
  const variants: ModelPriceTableData = {
    fetchedAtMs: 1,
    providers: {
      vendor: { "deepseek-v4-flash": [1, 2], "deepseek-v4-pro": [3, 4] },
    },
  };
  expect(suggestModelPrices("deepseek-v4-pro-free", variants)[0]?.model).toBe("deepseek-v4-pro");
});

it("keeps provider prices distinct and preserves unknown versus free cache prices", () => {
  const rows = suggestModelPrices("reseller/deepseek-v4-flash", table);
  expect(rows[0]).toEqual({
    provider: "reseller",
    model: "deepseek-v4-flash",
    price: { input: 9, output: 10, cacheWrite: 11 },
  });
  expect(rows.find((row) => row.provider === "vendor")?.price.cacheRead).toBe(0);
});
it("does not recommend models on generic qualifiers or numbers alone", () => {
  for (const name of ["auto", "free", "preview", "123", "unrelated-nonsense"]) {
    expect(suggestModelPrices(name, table)).toEqual([]);
  }
});
it("uses canonical links to keep differently named official aliases ahead of resellers", () => {
  const linked: ModelPriceTableData = {
    fetchedAtMs: 1,
    providers: {
      aaa: { "alibaba/deepseek-v4-flash": [8, 9, null, null, "deepseek/deepseek-v4-flash"] },
      deepseek: {
        "deepseek-v4-flash": [1, 2, 0, null, "deepseek/deepseek-v4.1-flash"],
        "other-alias": [1, 2, 0, null, "deepseek/deepseek-v4.1-flash"],
      },
      reseller: { "unrelated-name": [8, 9, null, null, "deepseek/deepseek-v4-flash"] },
      unknown: { "deepseek-v4-flash": [1, 2, 0] },
    },
  };
  const rows = suggestModelPrices("deepseek-v4-flash-free", linked);
  expect(rows.slice(0, 2).map((row) => row.model)).toEqual(["deepseek-v4-flash", "other-alias"]);
  for (const row of rows.slice(0, 2))
    expect(row).toMatchObject({
      official: true,
      canonicalModelId: "deepseek/deepseek-v4.1-flash",
      price: { input: 1, output: 2 },
    });
  expect(rows.find((row) => row.provider === "reseller")).toMatchObject({
    canonicalModelId: "deepseek/deepseek-v4.1-flash",
    price: { input: 8, output: 9 },
  });
  expect(rows.filter((row) => row.official).every((row) => row.provider === "deepseek")).toBe(true);
  expect(rows.find((row) => row.provider === "unknown")?.canonicalModelId).toBeUndefined();
});

it("does not invent official status from cyclic or absent metadata", () => {
  const cyclic: ModelPriceTableData = {
    fetchedAtMs: 1,
    providers: {
      vendor: { "test-model": [1, 2, null, null, "reseller/test-model"] },
      reseller: { "test-model": [1, 2, null, null, "vendor/test-model"] },
      unknown: { "test-model": [1, 2] },
    },
  };
  for (const row of suggestModelPrices("test-model", cyclic)) {
    expect(row.official).toBeUndefined();
    expect(row.canonicalModelId).toBeUndefined();
  }
});

it("bounds results and avoids filling the list with resellers of one model", () => {
  const large: ModelPriceTableData = { fetchedAtMs: 1, providers: {} };
  for (let i = 0; i < 20; i++) large.providers[`provider-${i}`] = { "deepseek-v4-flash": [i, i] };
  expect(suggestModelPrices("deepseek-v4-flash-free", large)).toHaveLength(2);
  for (let i = 0; i < 20; i++)
    large.providers[`provider-${i}`] = { [`deepseek-v4-flash-${i}`]: [i, i] };
  expect(suggestModelPrices("deepseek-v4-flash-free", large)).toHaveLength(6);
});
