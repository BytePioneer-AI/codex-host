import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, USAGE_STATISTICS_METHOD } from "@codexhost/shared-contracts";

import { ModelPriceCatalog } from "../src/model-prices.js";
import { UsageStatistics, usageEntryCostUsd } from "../src/usage-statistics.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

const NOW = new Date(2026, 9, 5, 12).getTime();
const DAY = 24 * 60 * 60 * 1000;

function entry(
  id: string,
  overrides: { [K in keyof HarnessUsageEntry]?: HarnessUsageEntry[K] | undefined } = {},
): HarnessUsageEntry {
  return {
    id,
    occurredAtMs: NOW,
    model: "priced-model",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1_000_000,
    ...overrides,
  } as HarnessUsageEntry;
}

/** Sources by ID; each read is counted, and a source may fail. */
class FakeStorage implements HarnessUsageStatisticsCapability {
  readonly reads: string[] = [];
  constructor(
    public sources: Map<string, { fingerprint: string; entries: HarnessUsageEntry[] | Error }>,
  ) {}
  async listSources(): Promise<HarnessUsageSource[]> {
    return [...this.sources].map(([id, { fingerprint }]) => ({ id, fingerprint }));
  }
  async readSource(id: string): Promise<HarnessUsageEntry[]> {
    this.reads.push(id);
    const source = this.sources.get(id);
    if (!source) throw new Error(`no ${id}`);
    if (source.entries instanceof Error) throw source.entries;
    return source.entries;
  }
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "usage-statistics-"));
  await writeFile(
    path.join(directory, "pricing.json"),
    JSON.stringify({
      models: {
        "priced-model": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        "no-cache-price": { input: 1, output: 2 },
      },
    }),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function statistics(now = NOW): UsageStatistics {
  return new UsageStatistics({
    directory: path.join(directory, "usage-statistics"),
    prices: new ModelPriceCatalog({ directory }),
    now: () => now,
  });
}

async function settledGet(stats: UsageStatistics, range: "today" | "7d" | "all" = "all") {
  await stats.get(range);
  await stats.settled();
  return stats.get(range);
}

describe("UsageStatistics", () => {
  it("reports a subsequent scan as incomplete until it settles", async () => {
    let now = NOW;
    const storage = new FakeStorage(new Map());
    const stats = new UsageStatistics({
      directory,
      prices: new ModelPriceCatalog({ directory }),
      now: () => now,
    });
    stats.attach(() => [{ harness: "pi", capability: storage }]);
    expect((await settledGet(stats)).reading.complete).toBe(true);
    const pending = Promise.withResolvers<HarnessUsageSource[]>();
    vi.spyOn(storage, "listSources").mockReturnValueOnce(pending.promise);
    now += 11_000;
    expect((await stats.get("all")).reading.complete).toBe(false);
    pending.resolve([]);
    await stats.settled();
    expect((await stats.get("all")).reading.complete).toBe(true);
    stats.close();
  });

  it("excludes disabled Harness caches after restart, retaining enabled caches on read failure", async () => {
    const storage = new FakeStorage(
      new Map([["one", { fingerprint: "1", entries: [entry("one")] }]]),
    );
    const original = statistics();
    original.attach(() => [
      { harness: "pi", capability: storage },
      { harness: "omp", capability: storage },
    ]);
    expect((await settledGet(original)).totals.requests).toBe(2);
    original.close();
    vi.spyOn(storage, "listSources").mockRejectedValue(new Error("temporarily unavailable"));
    const restarted = statistics(NOW + 60_000);
    restarted.attach(() => [{ harness: "pi", capability: storage }]);
    const result = await settledGet(restarted);
    expect(result.byHarness.map(({ harness }) => harness)).toEqual(["pi"]);
    expect(result.totals.requests).toBe(1);
    restarted.close();
  });
  it("keeps native credits separate per Harness/model, filtered, deduplicated and cached", async () => {
    const a = entry("a", { model: "auto", credits: 1.25, cwd: "/project" });
    const storage = new FakeStorage(
      new Map([
        [
          "one",
          {
            fingerprint: "1",
            entries: [
              a,
              entry("zero", { model: "auto", credits: 0 }),
              entry("unknown", { model: "auto" }),
            ],
          },
        ],
        ["fork", { fingerprint: "1", entries: [a] }],
      ]),
    );
    const sources = () => [
      { harness: "workbuddy", capability: storage },
      {
        harness: "codebuddy",
        capability: new FakeStorage(
          new Map([
            ["two", { fingerprint: "1", entries: [entry("a", { model: "auto", credits: 8 })] }],
          ]),
        ),
      },
    ];
    const stats = statistics();
    stats.attach(sources);
    const result = await settledGet(stats);
    expect(result.credits).toEqual([
      { harness: "codebuddy", model: "auto", credits: 8, reportedRequests: 1, requests: 1 },
      { harness: "workbuddy", model: "auto", credits: 1.25, reportedRequests: 2, requests: 3 },
    ]);
    expect(result.totals).toMatchObject({ requests: 4, costUsd: 0, unpricedRequests: 4 });
    expect(
      (await stats.get({ range: "all", harness: "workbuddy", project: "/project" })).credits,
    ).toEqual([
      { harness: "workbuddy", model: "auto", credits: 1.25, reportedRequests: 1, requests: 1 },
    ]);
    const restarted = statistics(NOW + 60_000);
    restarted.attach(sources);
    expect((await settledGet(restarted)).credits).toEqual(result.credits);
    expect(storage.reads).toEqual(["one", "fork"]);
    stats.close();
    restarted.close();
  });

  it("refreshes display labels independently of requests and prices, scoped by Harness", async () => {
    let now = NOW;
    let label = "priced-model";
    let fail = false;
    const storage = new FakeStorage(
      new Map([
        [
          "one",
          {
            fingerprint: "1",
            entries: [entry("a", { model: "internal-model" })],
          },
        ],
      ]),
    );
    const capability: HarnessUsageStatisticsCapability = {
      listSources: () => storage.listSources(),
      readSource: (id) => storage.readSource(id),
      readModelLabels: async () => {
        if (fail) throw new Error("metadata unavailable");
        return { "internal-model": label };
      },
    };
    const stats = new UsageStatistics({
      directory: path.join(directory, "usage-statistics"),
      prices: new ModelPriceCatalog({ directory }),
      now: () => now,
    });
    stats.attach(() => [
      { harness: "qoder", capability },
      {
        harness: "qoder-cn",
        capability: {
          ...capability,
          readModelLabels: async () => ({ "internal-model": "Different Name" }),
        },
      },
    ]);
    const first = await settledGet(stats);
    expect(first.modelLabels).toEqual([
      { harness: "qoder", model: "internal-model", label: "priced-model" },
      { harness: "qoder-cn", model: "internal-model", label: "Different Name" },
    ]);
    expect(first.byModel).toMatchObject([
      { model: "internal-model", requests: 2, unpricedRequests: 2, costUsd: 0 },
    ]);
    label = "Renamed";
    now += 60_000;
    const next = await settledGet(stats);
    expect(next.modelLabels?.[0]?.label).toBe("Renamed");
    expect(storage.reads).toEqual(["one", "one"]);
    expect(next.totals).toEqual(first.totals);
    fail = true;
    now += 60_000;
    const fallback = await settledGet(stats);
    expect(fallback.modelLabels?.[0]?.label).toBe("internal-model");
    expect(fallback.failures).toEqual([]);
    expect(fallback.totals).toEqual(first.totals);
    stats.close();
  });

  it("keeps session attribution through the on-disk cache", async () => {
    const storage = new FakeStorage(
      new Map([
        [
          "one",
          {
            fingerprint: "1",
            entries: [entry("a", { sessionId: "s1", cwd: "/work/app" })],
          },
        ],
      ]),
    );
    const stats = statistics();
    stats.attach(() => [{ harness: "pi", capability: storage }]);
    await settledGet(stats);
    const restarted = statistics(NOW + 60 * 1000);
    // Nothing changed natively: the restarted Host answers from its cache alone.
    restarted.attach(() => [{ harness: "pi", capability: storage }]);
    const result = await settledGet(restarted);
    expect(storage.reads).toEqual(["one"]);
    expect(result.sessions).toMatchObject([{ sessionId: "s1", project: "/work/app" }]);
    expect(result.byProject).toMatchObject([{ project: "/work/app", requests: 1 }]);
  });

  it("counts a request copied into several sources once and prices it at read time", async () => {
    const parent = [entry("a"), entry("b", { occurredAtMs: NOW - 3 * DAY })];
    const storage = new FakeStorage(
      new Map([
        ["parent", { fingerprint: "1", entries: parent }],
        // A fork repeats its parent's requests with the same IDs and times.
        [
          "fork",
          { fingerprint: "1", entries: [...parent, entry("c", { model: "unknown-model" })] },
        ],
      ]),
    );
    const stats = statistics();
    stats.attach(() => [{ harness: "pi", capability: storage }]);
    const result = await settledGet(stats);
    expect(result.reading).toEqual({ complete: true, sources: 2, read: 2 });
    expect(result.totals).toMatchObject({ requests: 3, costUsd: 6, unpricedRequests: 1 });
    expect(result.daily.map((row) => [row.date, row.requests])).toEqual([
      ["2026-10-02", 1],
      ["2026-10-05", 2],
    ]);
    expect(result.byModel.map((row) => [row.model, row.requests, row.costUsd])).toEqual([
      ["priced-model", 2, 6],
      ["unknown-model", 1, 0],
    ]);
    expect(result.byModel[1]).toMatchObject({ unpricedRequests: 1 });
    const today = await stats.get("today");
    expect(today.from).toBe("2026-10-05");
    expect(today.totals.requests).toBe(2);
  });

  it("asks the price table to fetch early when a request's model has no price", async () => {
    const prices = new ModelPriceCatalog({ directory });
    const missing = vi.spyOn(prices, "missing");
    const stats = new UsageStatistics({
      directory: path.join(directory, "usage-statistics"),
      prices,
      now: () => NOW,
    });
    const entries = [entry("priced"), entry("unpriced", { model: "brand-new-model" })];
    stats.attach(() => [
      {
        harness: "pi",
        capability: new FakeStorage(new Map([["one", { fingerprint: "1", entries }]])),
      },
    ]);
    await settledGet(stats);
    expect(missing).toHaveBeenCalled();
    missing.mockClear();
    await stats.get({ range: "all", model: "priced-model" });
    expect(missing).not.toHaveBeenCalled();
  });

  it("uses the cost a Harness recorded unless the user set a price for the model", async () => {
    const prices = new ModelPriceCatalog({ directory });
    const missing = vi.spyOn(prices, "missing");
    const stats = new UsageStatistics({
      directory: path.join(directory, "usage-statistics"),
      prices,
      now: () => NOW,
    });
    const entries = [
      // Not in any price table: its recorded cost is its cost.
      entry("native", { model: "grok-4.6-build", costUsd: 0.25 }),
      // The user's price for priced-model wins over a recorded cost.
      entry("overridden", { costUsd: 99 }),
    ];
    stats.attach(() => [
      {
        harness: "grok",
        capability: new FakeStorage(new Map([["one", { fingerprint: "1", entries }]])),
      },
    ]);
    const result = await settledGet(stats);
    expect(
      result.byModel.map((row) => [
        row.model,
        row.costUsd,
        row.unpricedRequests,
        row.harnessPricedRequests,
      ]),
    ).toEqual([
      // The user's price applies: not priced by the Harness's record.
      ["priced-model", 3, 0, 0],
      ["grok-4.6-build", 0.25, 0, 1],
    ]);
    // Priced by its own record: no early fetch of the price table.
    expect(missing).not.toHaveBeenCalled();
  });

  it("counts requests without token counts as unmetered: no tokens, no cost, not unpriced", async () => {
    const prices = new ModelPriceCatalog({ directory });
    const missing = vi.spyOn(prices, "missing");
    const stats = new UsageStatistics({
      directory: path.join(directory, "usage-statistics"),
      prices,
      now: () => NOW,
    });
    const entries = [
      entry("credits-only", {
        model: "qfmodel",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        tokensUnknown: true,
      }),
      entry("metered"),
    ];
    stats.attach(() => [
      {
        harness: "qoder",
        capability: new FakeStorage(new Map([["one", { fingerprint: "1", entries }]])),
      },
    ]);
    const result = await settledGet(stats);
    expect(result.totals).toMatchObject({ requests: 2, unmeteredRequests: 1, unpricedRequests: 0 });
    expect(result.byModel.find((row) => row.model === "qfmodel")).toMatchObject({
      requests: 1,
      unmeteredRequests: 1,
      unpricedRequests: 0,
      costUsd: 0,
      inputTokens: 0,
    });
    // An unknown model with no tokens is not a reason to fetch prices early.
    expect(missing).not.toHaveBeenCalled();
  });

  it("does not treat unknown cache counts or cache prices as zero", () => {
    const price = { input: 1, output: 2 };
    expect(usageEntryCostUsd(price, entry("x", { cachedInputTokens: undefined }))).toBeNull();
    expect(usageEntryCostUsd(price, entry("x", { cachedInputTokens: 10 }))).toBeNull();
    expect(usageEntryCostUsd(price, entry("x"))).toBe(3);
    expect(
      usageEntryCostUsd(
        { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        entry("x", {
          cachedInputTokens: 500_000,
          cacheWriteInputTokens: 500_000,
          cacheWrite1hInputTokens: 100_000,
        }),
      ),
    ).toBeCloseTo(0.05 + 0.5 + 0.2 + 2, 10);
  });

  it("reads a source again only when its fingerprint changes, and survives a restart", async () => {
    const storage = new FakeStorage(
      new Map([
        ["one", { fingerprint: "1", entries: [entry("a")] }],
        ["two", { fingerprint: "1", entries: [entry("b")] }],
      ]),
    );
    const stats = statistics();
    stats.attach(() => [{ harness: "claude-code", capability: storage }]);
    const first = await settledGet(stats);
    expect(storage.reads).toEqual(["one", "two"]);
    expect(await readdir(path.join(directory, "usage-statistics", "v6"))).toEqual([
      "claude-code.json",
    ]);

    // A new runtime starts from the cache and reads only what changed.
    storage.sources.set("two", { fingerprint: "2", entries: [entry("b"), entry("c")] });
    storage.sources.delete("one");
    const later = statistics(NOW + 60 * 1000);
    later.attach(() => [{ harness: "claude-code", capability: storage }]);
    const second = await settledGet(later);
    expect(storage.reads).toEqual(["one", "two", "two"]);
    expect(first.totals.requests).toBe(2);
    expect(second.totals.requests).toBe(2);
    expect(second.byHarness.map((row) => row.harness)).toEqual(["claude-code"]);
  });

  it("rebuilds a deleted or broken cache from native storage", async () => {
    const storage = new FakeStorage(
      new Map([["one", { fingerprint: "1", entries: [entry("a")] }]]),
    );
    const stats = statistics();
    stats.attach(() => [{ harness: "pi", capability: storage }]);
    const before = await settledGet(stats);
    await writeFile(path.join(directory, "usage-statistics", "v6", "pi.json"), "{broken");
    const again = statistics();
    again.attach(() => [{ harness: "pi", capability: storage }]);
    expect((await settledGet(again)).totals).toEqual(before.totals);
  });

  it("keeps other Harnesses when one cannot be read", async () => {
    const good = new FakeStorage(new Map([["one", { fingerprint: "1", entries: [entry("a")] }]]));
    const bad = new FakeStorage(
      new Map([["broken", { fingerprint: "1", entries: new Error("permission denied") }]]),
    );
    const failing: HarnessUsageStatisticsCapability = {
      listSources: () => Promise.reject(new Error("store missing")),
      readSource: () => Promise.reject(new Error("unreachable")),
    };
    const stats = statistics();
    stats.attach(() => [
      { harness: "pi", capability: good },
      { harness: "omp", capability: bad },
      { harness: "codebuddy", capability: failing },
    ]);
    const result = await settledGet(stats);
    expect(result.byHarness.map((row) => row.harness)).toEqual(["pi"]);
    expect(result.failures).toEqual([
      { harness: "codebuddy", message: "store missing" },
      { harness: "omp", message: "permission denied" },
    ]);
  });

  it("skips entries an Adapter returns out of contract", async () => {
    const storage = new FakeStorage(
      new Map([
        [
          "one",
          {
            fingerprint: "1",
            entries: [
              entry("ok"),
              entry("negative", { outputTokens: -1 }),
              entry("cache-over-input", { cachedInputTokens: 2_000_000 }),
              entry("no-time", { occurredAtMs: 0 }),
            ],
          },
        ],
      ]),
    );
    const stats = statistics();
    stats.attach(() => [{ harness: "pi", capability: storage }]);
    expect((await settledGet(stats)).totals.requests).toBe(1);
  });
});

it("serves statistics through the Host from Adapters that expose local usage", async () => {
  const storage = new FakeStorage(new Map([["one", { fingerprint: "1", entries: [entry("a")] }]]));
  const adapter = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
    usageStatistics: storage,
  });
  const usageStatistics = statistics();
  const fixture = createFixture({
    externalAdapters: new Map([["pi", adapter]]) as never,
    usageStatistics,
  });
  try {
    await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "all" });
    await usageStatistics.settled();
    expect(
      await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "all" }),
    ).toMatchObject({ result: { byHarness: [{ harness: "pi", requests: 1, costUsd: 3 }] } });
    expect(
      await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, {
        range: "all",
        harness: "pi",
        model: null,
      }),
    ).toMatchObject({ result: { filters: { unknownModel: true }, totals: { requests: 0 } } });
    expect(
      await fixture.host.handleConsoleRequest(USAGE_STATISTICS_METHOD, { range: "1y" }),
    ).toMatchObject({ error: { code: -32602 } });
  } finally {
    usageStatistics.close();
    await stopFixture(fixture);
  }
});

describe("UsageStatistics queries", () => {
  const HOUR = 60 * 60 * 1000;

  async function seeded(entries: HarnessUsageEntry[], others: HarnessUsageEntry[] = []) {
    const stats = statistics();
    stats.attach(() => [
      {
        harness: "pi",
        capability: new FakeStorage(new Map([["one", { fingerprint: "1", entries }]])),
      },
      {
        harness: "codex",
        capability: new FakeStorage(new Map([["two", { fingerprint: "1", entries: others }]])),
      },
    ]);
    await settledGet(stats);
    return stats;
  }

  it("narrows every figure by Harness, Model and project, offering all values of the range", async () => {
    const stats = await seeded(
      [
        entry("a", { cwd: "/work/app", sessionId: "s1" }),
        entry("b", { model: undefined, sessionId: "s1", cwd: "/work/app" }),
        entry("c", { cwd: "/work/lib", sessionId: "s2" }),
      ],
      [entry("d")],
    );
    const all = await stats.get({ range: "7d" });
    expect(all.options).toEqual({
      harnesses: ["codex", "pi"],
      models: ["priced-model", null],
      projects: ["/work/app", "/work/lib", null],
    });
    const unknownModel = await stats.get({ range: "7d", model: null });
    expect(unknownModel.totals.requests).toBe(1);
    expect(unknownModel.filters).toMatchObject({ model: null, unknownModel: true });
    const project = await stats.get({ range: "7d", harness: "pi", project: "/work/app" });
    expect(project.totals.requests).toBe(2);
    expect(project.byHarness.map((row) => row.harness)).toEqual(["pi"]);
    // Options still list everything the range holds.
    expect(project.options.harnesses).toEqual(["codex", "pi"]);
    const noProject = await stats.get({ range: "7d", project: null });
    expect(noProject.byHarness.map((row) => row.harness)).toEqual(["codex"]);
  });

  it("narrows to one day while the daily series keeps the whole range", async () => {
    const stats = await seeded([
      entry("today", { occurredAtMs: NOW }),
      entry("yesterday", { occurredAtMs: NOW - DAY }),
      entry("before", { occurredAtMs: NOW - 2 * DAY }),
    ]);
    const result = await stats.get({ range: "7d", date: "2026-10-04" });
    expect(result.filters.date).toBe("2026-10-04");
    expect(result.totals.requests).toBe(1);
    expect(result.daily.map((row) => row.date)).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    // A date outside the range is ignored rather than returning nothing.
    expect((await stats.get({ range: "today", date: "2026-10-01" })).filters.date).toBeNull();
  });

  it("buckets by local weekday and hour", async () => {
    const stats = await seeded([
      entry("noon", { occurredAtMs: NOW }),
      entry("noon-again", { occurredAtMs: NOW + 60_000 }),
      entry("morning", { occurredAtMs: NOW - 3 * HOUR }),
    ]);
    const weekday = new Date(NOW).getDay();
    expect(
      (await stats.get({ range: "today" })).hourly.map((row) => [
        row.weekday,
        row.hour,
        row.requests,
      ]),
    ).toEqual([
      [weekday, 9, 1],
      [weekday, 12, 2],
    ]);
  });

  it("lists the top sessions by cost and by tokens without cache", async () => {
    const stats = await seeded([
      entry("a1", { sessionId: "pricey", cwd: "/work/app" }),
      entry("a2", { sessionId: "pricey", model: "other-model", occurredAtMs: NOW - HOUR }),
      // Unpriced, so no cost, but the most tokens: listed for its tokens.
      entry("b1", {
        sessionId: "big",
        model: "unknown-model",
        inputTokens: 9_000_000,
        outputTokens: 9_000_000,
      }),
      entry("orphan"),
    ]);
    const result = await stats.get({ range: "today" });
    expect(result.sessions.map((session) => session.sessionId)).toEqual(["pricey", "big"]);
    expect(result.sessions[0]).toMatchObject({
      harness: "pi",
      project: "/work/app",
      models: ["priced-model", "other-model"],
      firstAtMs: NOW - HOUR,
      lastAtMs: NOW,
      requests: 2,
    });
    // Requests without a session still count everywhere else.
    expect(result.totals.requests).toBe(4);
  });
});
