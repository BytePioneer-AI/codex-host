import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_PRICE_DEFAULT_METHOD,
  MODEL_PRICE_OVERRIDES_GET_METHOD,
  MODEL_PRICE_OVERRIDES_SET_METHOD,
} from "@codexhost/shared-contracts";

import {
  readModelPriceOverridesFile,
  updateModelPriceOverridesFile,
} from "../src/model-price-overrides-file.js";
import { ModelPriceCatalog } from "../src/model-prices.js";
import { bundledModelPrices } from "../src/model-prices.generated.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "model-price-overrides-"));
  file = path.join(directory, "pricing.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("pricing.json editing", () => {
  it("adds, edits, renames and removes one key while keeping other entries and fields", async () => {
    await writeFile(
      file,
      JSON.stringify({
        note: "kept",
        models: { other: { input: 1, output: 2, cacheRead: 0 } },
      }),
    );
    let view = await updateModelPriceOverridesFile(file, {
      key: "my-model",
      price: { input: 0.5, output: 1.5, cacheWrite1h: 0 },
    });
    expect(view.entries).toEqual([
      { key: "other", price: { input: 1, output: 2, cacheRead: 0 } },
      { key: "my-model", price: { input: 0.5, output: 1.5, cacheWrite1h: 0 } },
    ]);
    view = await updateModelPriceOverridesFile(file, {
      key: "openrouter/my-model",
      previousKey: "my-model",
      price: { input: 0.6, output: 1.6 },
    });
    expect(view.entries.map((entry) => entry.key)).toEqual(["other", "openrouter/my-model"]);
    view = await updateModelPriceOverridesFile(file, { key: "openrouter/my-model", price: null });
    expect(view).toEqual({
      path: file,
      entries: [{ key: "other", price: { input: 1, output: 2, cacheRead: 0 } }],
      error: null,
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      note: "kept",
      models: { other: { input: 1, output: 2, cacheRead: 0 } },
    });
  });

  it("treats Object.prototype names as ordinary model keys", async () => {
    await writeFile(
      file,
      '{ "models": { "__proto__": { "input": 1, "output": 1 }, "kept": { "input": 2, "output": 2 } } }',
    );
    let view = await updateModelPriceOverridesFile(file, {
      key: "constructor",
      price: { input: 3, output: 3 },
    });
    expect(view.entries.map((entry) => entry.key)).toEqual(["__proto__", "kept", "constructor"]);
    view = await updateModelPriceOverridesFile(file, {
      key: "__proto__",
      previousKey: "__proto__",
      price: { input: 4, output: 4, cacheRead: 0 },
    });
    expect(view.entries).toEqual([
      { key: "__proto__", price: { input: 4, output: 4, cacheRead: 0 } },
      { key: "kept", price: { input: 2, output: 2 } },
      { key: "constructor", price: { input: 3, output: 3 } },
    ]);
    await expect(
      updateModelPriceOverridesFile(file, {
        key: "toString",
        previousKey: "hasOwnProperty",
        price: null,
      }),
    ).rejects.toThrow("no longer exists");
    await updateModelPriceOverridesFile(file, {
      key: "toString",
      previousKey: "constructor",
      price: { input: 5, output: 5 },
    });
    await expect(
      updateModelPriceOverridesFile(file, { key: "__proto__", price: { input: 6, output: 6 } }),
    ).rejects.toThrow("already exists");
    view = await updateModelPriceOverridesFile(file, { key: "kept", price: null });
    expect(view.entries).toEqual([
      { key: "__proto__", price: { input: 4, output: 4, cacheRead: 0 } },
      { key: "toString", price: { input: 5, output: 5 } },
    ]);
    const text = await readFile(file, "utf8");
    expect(text).toContain('"__proto__"');
    const stored = JSON.parse(text) as { models: Record<string, unknown> };
    expect(Object.keys(stored.models)).toEqual(["__proto__", "toString"]);
    // The Host's next lookup sees the same entries.
    const lookup = await new ModelPriceCatalog({ directory }).lookup();
    expect(lookup.find("__proto__")).toEqual({ input: 4, output: 4, cacheRead: 0 });
    expect(lookup.find("toString")).toEqual({ input: 5, output: 5 });
    expect(lookup.find("constructor")).toBeNull();
  });

  it("creates the file and rejects duplicate or stale keys", async () => {
    expect(await readModelPriceOverridesFile(file)).toEqual({
      path: file,
      entries: [],
      error: null,
    });
    await updateModelPriceOverridesFile(file, { key: "a", price: { input: 1, output: 1 } });
    await updateModelPriceOverridesFile(file, { key: "b", price: { input: 2, output: 2 } });
    await expect(
      updateModelPriceOverridesFile(file, { key: "a", price: { input: 3, output: 3 } }),
    ).rejects.toThrow("already exists");
    await expect(
      updateModelPriceOverridesFile(file, {
        key: "b",
        previousKey: "a",
        price: { input: 3, output: 3 },
      }),
    ).rejects.toThrow("already exists");
    await expect(
      updateModelPriceOverridesFile(file, {
        key: "c",
        previousKey: "missing",
        price: { input: 3, output: 3 },
      }),
    ).rejects.toThrow("no longer exists");
    expect((await readModelPriceOverridesFile(file)).entries.map((entry) => entry.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("reports and never overwrites a file the Host ignores", async () => {
    const text = '{ "models": { "x": { "input": 1 } } }';
    await writeFile(file, text);
    const view = await readModelPriceOverridesFile(file);
    expect(view.entries).toEqual([]);
    expect(view.error).toContain("'x'");
    await expect(
      updateModelPriceOverridesFile(file, { key: "y", price: { input: 1, output: 1 } }),
    ).rejects.toThrow("was not changed");
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("is used by the next lookup without a restart", async () => {
    const catalog = new ModelPriceCatalog({ directory });
    expect((await catalog.lookup()).find("my-local-model")).toBeNull();
    await updateModelPriceOverridesFile(file, {
      key: "my-local-model",
      price: { input: 0.5, output: 1.5 },
    });
    expect((await catalog.lookup()).find("my-local-model")).toEqual({ input: 0.5, output: 1.5 });
    await updateModelPriceOverridesFile(file, { key: "my-local-model", price: null });
    expect((await catalog.lookup()).find("my-local-model")).toBeNull();
  });
});

it("serves custom prices and default prices through the Host console channel", async () => {
  const modelPrices = new ModelPriceCatalog({ directory });
  const fixture = createFixture({ modelPrices });
  const model = Object.values(bundledModelPrices.providers)
    .flatMap((entries) => Object.keys(entries))
    .find((id) => modelPrices.defaultPrice(id) !== null);
  if (!model) throw new Error("The bundled price table has no priced model");
  try {
    const defaultPrice = modelPrices.defaultPrice(model);
    expect(defaultPrice).not.toBeNull();
    const key = model;
    expect(
      await fixture.host.handleConsoleRequest(MODEL_PRICE_OVERRIDES_SET_METHOD, {
        key,
        price: { input: 9, output: 9 },
      }),
    ).toMatchObject({ result: { path: file, entries: [{ key }], error: null } });
    // The default stays the catalog price while the override is in effect.
    expect(await fixture.host.handleConsoleRequest(MODEL_PRICE_DEFAULT_METHOD, { model })).toEqual({
      result: { price: defaultPrice, suggestions: modelPrices.similarPrices(model) },
    });
    expect((await modelPrices.lookup()).find(model)).toEqual({ input: 9, output: 9 });
    expect(
      await fixture.host.handleConsoleRequest(MODEL_PRICE_OVERRIDES_SET_METHOD, {
        key,
        price: { input: -1, output: 1 },
      }),
    ).toMatchObject({ error: { code: -32000, message: "Invalid custom model price" } });
    expect(
      await fixture.host.handleConsoleRequest(MODEL_PRICE_OVERRIDES_SET_METHOD, {
        key: " padded",
        price: { input: 1, output: 1 },
      }),
    ).toMatchObject({ error: { code: -32000 } });
    expect(
      await fixture.host.handleConsoleRequest(MODEL_PRICE_DEFAULT_METHOD, {
        model,
        provider: "anthropic",
      }),
    ).toMatchObject({ error: { code: -32000, message: "Invalid custom model price" } });
    expect(
      await fixture.host.handleConsoleRequest(MODEL_PRICE_OVERRIDES_SET_METHOD, {
        key,
        price: null,
      }),
    ).toEqual({ result: { path: file, entries: [], error: null } });
    expect(await fixture.host.handleConsoleRequest(MODEL_PRICE_OVERRIDES_GET_METHOD, {})).toEqual({
      result: { path: file, entries: [], error: null },
    });
  } finally {
    await stopFixture(fixture);
  }
});
