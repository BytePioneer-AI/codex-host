import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ModelPriceCatalog,
  ModelPriceLookup,
  compactModelsDev,
  parseModelPriceOverrides,
  priceNames,
  type ModelPriceTableData,
} from "../src/model-prices.js";
import { bundledModelPrices } from "../src/model-prices.generated.js";

const table: ModelPriceTableData = {
  fetchedAtMs: 0,
  providers: {
    anthropic: { "claude-sonnet-4-5": [3, 15, 0.3, 3.75, true] },
    openrouter: { "claude-sonnet-4-5": [3.3, 16, null, null, "anthropic/claude-sonnet-4-5"] },
    reseller: {
      "lonely-model": [1, 2],
      "lonely-alias": [0, 0, 0, 0, "lab/lab-v2-flash"],
      "orphan-single": [0, 0, 0, 0, "nowhere/missing"],
    },
    zhipuai: { "glm-5.3-flash": [0.15, 0.5, 0.03, 0, true] },
    "scnet-token-plan": { "GLM-5.3-Flash": [0, 0, 0, null, "zhipuai/glm-5.3-flash"] },
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

  it("resolves a single canonical listing instead of assuming its plan price applies", () => {
    const official = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };
    expect(lookup.find("GLM-5.3-Flash")).toEqual(official);
    expect(lookup.find("GLM-5.3-Flash", "start-plan")).toEqual(official);
    expect(lookup.find("Glm-5.3-Flash")).toEqual(official);
  });

  it("preserves an explicitly selected provider's zero plan price and user overrides", () => {
    expect(lookup.find("GLM-5.3-Flash", "scnet-token-plan")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
    });
    const overridden = new ModelPriceLookup(
      table,
      parseModelPriceOverrides({ models: { "GLM-5.3-Flash": { input: 2, output: 3 } } }),
    );
    expect(overridden.find("GLM-5.3-Flash")).toEqual({ input: 2, output: 3 });
  });

  it("resolves a single reseller listing through the official vendor's agreeing aliases", () => {
    expect(lookup.find("lonely-alias")).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
  });

  it("leaves a single canonical listing unpriced when its official price cannot be resolved", () => {
    expect(lookup.find("orphan-single")).toBeNull();
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

describe("ModelPriceCatalog freshness", () => {
  const HOUR = 60 * 60 * 1000;

  /** A catalog whose clock and models.dev responses the test controls. */
  async function running(ageHours: number, overrides?: object) {
    const directory = await tempDirectory();
    if (overrides) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "pricing.json"), JSON.stringify(overrides));
    }
    const clock = { now: bundledModelPrices.fetchedAtMs + ageHours * HOUR };
    const state = { requests: 0, models: 1_000 };
    const catalog = new ModelPriceCatalog({
      directory,
      now: () => clock.now,
      fetch: async () => {
        state.requests += 1;
        return new Response(JSON.stringify(catalogApi(state.models)));
      },
    });
    await catalog.start();
    await catalog.settled();
    return { catalog, clock, state, directory };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches at start only once the table is a day old", async () => {
    const young = await running(23);
    expect(young.state.requests).toBe(0);
    young.catalog.close();
    const old = await running(25);
    expect(old.state.requests).toBe(1);
    expect((await old.catalog.lookup()).find("model-1")).not.toBeNull();
    old.catalog.close();
  });

  it("checks every hour while running and fetches when the day is up", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { catalog, clock, state } = await running(20);
    expect(state.requests).toBe(0);
    clock.now += HOUR;
    vi.advanceTimersByTime(HOUR);
    await catalog.settled();
    expect(state.requests).toBe(0);
    clock.now += 4 * HOUR;
    vi.advanceTimersByTime(HOUR);
    await catalog.settled();
    expect(state.requests).toBe(1);
    // The fetched table is fresh: the next hours do not fetch again.
    vi.advanceTimersByTime(3 * HOUR);
    await catalog.settled();
    expect(state.requests).toBe(1);
    catalog.close();
    clock.now += 48 * HOUR;
    vi.advanceTimersByTime(HOUR);
    expect(state.requests).toBe(1);
  });

  it("fetches early for an unpriced model, at most every six hours", async () => {
    const fresh = await running(5);
    fresh.catalog.missing();
    await fresh.catalog.settled();
    expect(fresh.state.requests).toBe(0);
    fresh.catalog.close();

    const { catalog, clock, state } = await running(7);
    catalog.missing();
    catalog.missing();
    await catalog.settled();
    expect(state.requests).toBe(1);
    // Fetched just now: another unpriced request waits six hours.
    clock.now += 5 * HOUR;
    catalog.missing();
    await catalog.settled();
    expect(state.requests).toBe(1);
    clock.now += 2 * HOUR;
    catalog.missing();
    await catalog.settled();
    expect(state.requests).toBe(2);
    catalog.close();
  });

  it("waits six hours after a failed attempt too", async () => {
    const directory = await tempDirectory();
    const clock = { now: bundledModelPrices.fetchedAtMs + 7 * HOUR };
    let requests = 0;
    const catalog = new ModelPriceCatalog({
      directory,
      now: () => clock.now,
      fetch: async () => {
        requests += 1;
        throw new Error("offline");
      },
      diagnose: () => undefined,
    });
    await catalog.start();
    catalog.missing();
    await catalog.settled();
    clock.now += HOUR;
    catalog.missing();
    await catalog.settled();
    expect(requests).toBe(1);
    catalog.close();
  });

  it("never replaces or drops the user's prices when it fetches", async () => {
    const overrides = {
      models: {
        "model-1": { input: 9, output: 9 },
        "my-own-model": { input: 1, output: 2 },
      },
    };
    const { catalog, state, directory } = await running(25, overrides);
    expect(state.requests).toBe(1);
    const lookup = await catalog.lookup();
    // Listed by models.dev now, but the user's price still wins.
    expect(lookup.find("model-1")).toEqual({ input: 9, output: 9 });
    expect(lookup.find("my-own-model")).toEqual({ input: 1, output: 2 });
    expect(catalog.defaultPrice("model-1")).toEqual({ input: 1, output: 2, cacheRead: 0.1 });
    expect(JSON.parse(await readFile(path.join(directory, "pricing.json"), "utf8"))).toEqual(
      overrides,
    );
    catalog.close();
  });

  it("does nothing without a data directory", async () => {
    const catalog = new ModelPriceCatalog();
    await catalog.start();
    catalog.missing();
    await catalog.settled();
    expect((await catalog.lookup()).find("claude-sonnet-4-5")).not.toBeNull();
    catalog.close();
  });
});

describe("ModelPriceLookup vendors and spellings", () => {
  const catalog: ModelPriceTableData = {
    fetchedAtMs: 0,
    providers: {
      // Vendors: marked official for a model of their own, or named by a canonical ID.
      openai: {
        "gpt-flagship": [4, 20, 0.4, 5, true],
        "gpt-spark": [1.75, 14, 0.175],
        "both-makers": [1, 1],
        "split-makers": [1, 1],
      },
      relay: { "grok-x": [2, 6, 0.5, null, "xai/grok-x"] },
      xai: { "both-makers": [1, 1], "split-makers": [2, 2] },
      anthropic: { "claude-opus-4-6": [5, 25, 0.5, 6.25, true] },
      // Resellers and plans: never vendors.
      poe: { "gpt-spark": [0, 0], "both-makers": [0, 0] },
      opencode: { "gpt-spark": [1.75, 14, 0.175] },
      resellerX: { unmarked: [1, 1] },
      resellerY: { unmarked: [2, 2] },
    },
  };
  const lookup = new ModelPriceLookup(catalog);

  it("takes the vendor's own listing when no listing is marked official", () => {
    expect(lookup.find("gpt-spark")).toEqual({ input: 1.75, output: 14, cacheRead: 0.175 });
    // Two vendors that agree; the reseller's plan price is ignored.
    expect(lookup.find("both-makers")).toEqual({ input: 1, output: 1 });
  });

  it("still does not guess between resellers or between vendors that disagree", () => {
    expect(lookup.find("unmarked")).toBeNull();
    expect(lookup.find("split-makers")).toBeNull();
  });

  it("finds a model under its dated, effort and version spellings", () => {
    const opus = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(lookup.find("claude-opus-4.6")).toEqual(opus);
    expect(lookup.find("claude-opus-4-6-20260101")).toEqual(opus);
    expect(lookup.find("claude-opus-4.6-2026-01-01")).toEqual(opus);
    expect(lookup.find("gpt-flagship-high")).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    });
    // A suffix that is not a date or an effort is not dropped.
    expect(lookup.find("grok-x-build")).toBeNull();
  });

  it("lets a price set for the name as given win over another spelling", () => {
    const custom = { input: 9, output: 9 };
    const withOverride = new ModelPriceLookup(catalog, new Map([["claude-opus-4.6", custom]]));
    expect(withOverride.find("claude-opus-4.6")).toEqual(custom);
  });

  it("lists spellings in order, the name as given first", () => {
    expect(priceNames("claude-opus-4.6-20260101-high")).toEqual([
      "claude-opus-4.6-20260101-high",
      "claude-opus-4.6-20260101",
      "claude-opus-4.6",
      "claude-opus-4-6-20260101-high",
      "claude-opus-4-6-20260101",
      "claude-opus-4-6",
    ]);
    expect(priceNames("plain")).toEqual(["plain"]);
  });
});
