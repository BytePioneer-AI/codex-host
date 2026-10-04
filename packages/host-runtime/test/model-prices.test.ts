import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelPriceCatalog,
  ModelPriceLookup,
  compactModelsDev,
  parseModelPriceOverrides,
  type ModelPriceTableData,
} from "../src/model-prices.js";
import { bundledModelPrices } from "../src/model-prices.generated.js";

const table: ModelPriceTableData = {
  fetchedAtMs: 0,
  providers: {
    anthropic: { "claude-sonnet-4-5": [3, 15, 0.3, 3.75, true] },
    openrouter: { "claude-sonnet-4-5": [3.3, 16, null, null, "anthropic/claude-sonnet-4-5"] },
    reseller: { "lonely-model": [1, 2] },
    alpha: { shared: [1, 1] },
    beta: { shared: [2, 2] },
    deepseek: { "deepseek-flash": [0.15, 0.6, 0.003, null, "deepseek/deepseek-v4.1-flash"] },
    "302ai": { "deepseek-flash": [0.15, 0.6, 0.003, null, "deepseek/deepseek-v4.1-flash"] },
    vendor: {
      "v-flash": [0.15, 0.6, 0.003, null, "vendor/v-next"],
      "v-old": [1, 2, null, null, "vendor/v-flash"],
    },
    resellerA: {
      "v-flash": [0.1, 0.2, null, null, "vendor/v-flash"],
      "v-old": [1.1, 2.2, null, null, "vendor/v-old"],
    },
    resellerB: { "v-flash": [0.12, 0.3, null, null, "vendor/v-flash-0731"] },
    reseller2: { "orphan-alias": [9, 9, null, null, "nowhere/orphan"] },
    // The vendor lists its newest model only under aliases; resellers use the exact ID.
    lab: {
      "lab-flash": [0.15, 0.6, 0.003, null, "lab/lab-v2-flash"],
      "lab-v1-flash": [0.15, 0.6, 0.003, null, "lab/lab-v2-flash"],
    },
    reseller4: { "lab-v2-flash": [0.04, 0.08, 0.008, null, "lab/lab-v2-flash"] },
    reseller5: { "lab-v2-flash": [0, 0, 0, 0, "lab/lab-v2-flash"] },
    reseller3: { "orphan-alias": [8, 8, null, null, "nowhere/orphan"] },
  },
};

function catalogApi(count: number) {
  const models: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    models[`model-${index}`] = { cost: { input: 1, output: 2, cache_read: 0.1 } };
  }
  return { example: { models } };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-prices-"));
  directories.push(directory);
  return directory;
}

describe("ModelPriceLookup", () => {
  const lookup = new ModelPriceLookup(table);

  it("matches provider and model exactly first", () => {
    expect(lookup.find("claude-sonnet-4-5", "openrouter")).toEqual({ input: 3.3, output: 16 });
  });

  it("resolves a model listed by several providers to its official listing", () => {
    expect(lookup.find("claude-sonnet-4-5")).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(lookup.find("claude-sonnet-4-5", "my-alias")).toEqual(lookup.find("claude-sonnet-4-5"));
  });

  it("uses the official provider's listing of an alias whose canonical model is unlisted", () => {
    expect(lookup.find("deepseek-flash")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
    // No listing by the official provider: still no guess.
    expect(lookup.find("orphan-alias")).toBeNull();
  });

  it("prefers the vendor's own listing when resellers disagree on its version", () => {
    expect(lookup.find("v-flash")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  it("prices an official model the vendor lists only under agreeing aliases", () => {
    expect(lookup.find("lab-v2-flash")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  it("follows canonical links to the final official listing", () => {
    // v-old's resellers name vendor/v-old and vendor/v-flash; both are the vendor's.
    expect(lookup.find("v-old")).toEqual({ input: 1, output: 2 });
  });

  it("matches a differently cased ID only when its priced spellings agree", () => {
    expect(lookup.find("Claude-Sonnet-4-5")).toEqual(lookup.find("claude-sonnet-4-5"));
    expect(lookup.find("V-Flash")).toEqual(lookup.find("v-flash"));
  });

  it("uses a single listing and refuses to guess between unrelated listings", () => {
    expect(lookup.find("lonely-model")).toEqual({ input: 1, output: 2 });
    expect(lookup.find("shared")).toBeNull();
    expect(lookup.find("auto")).toBeNull();
    expect(lookup.find("Shared")).toBeNull();
  });

  it("prefers user overrides by provider/model, then model", () => {
    const overridden = new ModelPriceLookup(
      table,
      parseModelPriceOverrides({
        models: {
          shared: { input: 5, output: 6 },
          "beta/shared": { input: 7, output: 8, cacheRead: 0.5 },
        },
      }),
    );
    expect(overridden.find("shared")).toEqual({ input: 5, output: 6 });
    expect(overridden.find("shared", "beta")).toEqual({ input: 7, output: 8, cacheRead: 0.5 });
  });
});

describe("price sources", () => {
  it("compacts models.dev and rejects a truncated catalog", () => {
    const providers = compactModelsDev({
      ...catalogApi(1_000),
      anthropic: {
        models: {
          sonnet: {
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            canonical_model_id: "anthropic/sonnet",
          },
          free: { cost: { input: 0, output: 0 } },
          unpriced: {},
        },
      },
    });
    expect(providers.anthropic).toEqual({ sonnet: [3, 15, 0.3, 3.75, true], free: [0, 0] });
    expect(providers.example?.["model-0"]).toEqual([1, 2, 0.1]);
    expect(() => compactModelsDev(catalogApi(10))).toThrow();
  });

  it("rejects invalid overrides as a whole", () => {
    expect(() => parseModelPriceOverrides({ models: { a: { input: 1 } } })).toThrow();
    expect(() => parseModelPriceOverrides({ models: { a: { input: 1, output: -1 } } })).toThrow();
    expect(() =>
      parseModelPriceOverrides({ models: { a: { input: 1, output: 1, reasoning: 1 } } }),
    ).toThrow();
  });

  it("ships a usable bundled snapshot", () => {
    expect(new ModelPriceLookup(bundledModelPrices).find("claude-sonnet-4-5")).not.toBeNull();
  });
});

describe("ModelPriceCatalog", () => {
  it("refreshes a stale table in the background and caches it atomically", async () => {
    const directory = await tempDirectory();
    let requests = 0;
    const catalog = new ModelPriceCatalog({
      directory,
      now: () => bundledModelPrices.fetchedAtMs + 8 * 24 * 60 * 60 * 1000,
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify(catalogApi(1_000)));
      },
    });
    await catalog.start();
    await expect.poll(async () => (await catalog.lookup()).find("model-1")).not.toBeNull();
    expect(requests).toBe(1);
    const cached = JSON.parse(
      await readFile(path.join(directory, "pricing", "models-dev.json"), "utf8"),
    );
    expect(cached.providers.example["model-1"]).toEqual([1, 2, 0.1]);

    // A later start finds the fresh cache and does not fetch again.
    const restarted = new ModelPriceCatalog({
      directory,
      now: () => cached.fetchedAtMs + 1_000,
      fetch: async () => {
        requests += 1;
        return new Response("{}");
      },
    });
    await restarted.start();
    expect((await restarted.lookup()).find("model-1")).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
    });
    expect(requests).toBe(1);
  });

  it("keeps the current table when a refresh fails", async () => {
    const directory = await tempDirectory();
    const diagnostics: string[] = [];
    const catalog = new ModelPriceCatalog({
      directory,
      now: () => bundledModelPrices.fetchedAtMs + 8 * 24 * 60 * 60 * 1000,
      fetch: async () => {
        throw new Error("offline");
      },
      diagnose: (message) => diagnostics.push(message),
    });
    await catalog.start();
    await expect.poll(() => diagnostics.length).toBe(1);
    expect((await catalog.lookup()).find("claude-sonnet-4-5")).not.toBeNull();
  });

  it("reloads pricing.json when it changes and ignores an invalid file", async () => {
    const directory = await tempDirectory();
    const diagnostics: string[] = [];
    const catalog = new ModelPriceCatalog({
      directory,
      now: () => bundledModelPrices.fetchedAtMs,
      diagnose: (message) => diagnostics.push(message),
    });
    await catalog.start();
    expect((await catalog.lookup()).find("my-local-model")).toBeNull();

    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "pricing.json");
    await writeFile(
      file,
      JSON.stringify({ models: { "my-local-model": { input: 1, output: 4 } } }),
    );
    expect((await catalog.lookup()).find("my-local-model")).toEqual({ input: 1, output: 4 });

    await writeFile(file, "{ not json");
    expect((await catalog.lookup()).find("my-local-model")).toBeNull();
    expect(diagnostics).toHaveLength(1);
  });

  it("uses only the bundled snapshot without options", async () => {
    const catalog = new ModelPriceCatalog();
    await catalog.start();
    expect((await catalog.lookup()).find("claude-sonnet-4-5")).not.toBeNull();
  });
});
