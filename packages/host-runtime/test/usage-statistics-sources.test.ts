import { describe, expect, it, vi } from "vitest";
import type {
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import { HarnessUsageSourceChangedError } from "@codexhost/harness-adapter/usage-statistics";
import { readUsageStatisticsSources } from "../src/usage-statistics-sources.js";

const signal = new AbortController().signal;
const initial = [
  { id: "growing", fingerprint: "1" },
  { id: "stable", fingerprint: "1" },
];

async function collect(capability: HarnessUsageStatisticsCapability, sources = initial) {
  const results = [];
  for await (const result of readUsageStatisticsSources(capability, sources, signal))
    results.push(result);
  return results;
}

describe("usage source retries", () => {
  it("finishes the current listing before retrying, uses fresh fingerprints, and can recover on the last attempt", async () => {
    const order: string[] = [];
    let version = 1;
    const capability: HarnessUsageStatisticsCapability = {
      listSources: vi.fn(async () => {
        order.push("list");
        return [{ id: "growing", fingerprint: String(++version) }];
      }),
      readSource: vi.fn(async (id) => {
        order.push(`${id}:${version}`);
        if (id === "growing" && version < 3) throw new HarnessUsageSourceChangedError("changed");
        return [];
      }),
    };
    expect(await collect(capability)).toEqual([
      { source: initial[1], entries: [] },
      { source: { id: "growing", fingerprint: "3" }, entries: [] },
    ]);
    expect(order).toEqual(["growing:1", "stable:1", "list", "growing:2", "list", "growing:3"]);
  });

  it("does not retry ordinary errors", async () => {
    const error = new Error("permission denied");
    const capability = {
      listSources: vi.fn(async () => initial),
      readSource: vi.fn(async () => {
        throw error;
      }),
    };
    expect(await collect(capability, initial.slice(0, 1))).toEqual([{ source: initial[0], error }]);
    expect(capability.listSources).not.toHaveBeenCalled();
    expect(capability.readSource).toHaveBeenCalledOnce();
  });

  it.each(["removed", "listing failed"])("handles a changed source when %s", async (state) => {
    const error = new Error("listing unavailable");
    const capability = {
      listSources: vi.fn(async (): Promise<HarnessUsageSource[]> => {
        if (state === "listing failed") throw error;
        return [];
      }),
      readSource: vi.fn(async () => {
        throw new HarnessUsageSourceChangedError("changed");
      }),
    };
    expect(await collect(capability, initial.slice(0, 1))).toEqual([
      state === "removed" ? { source: initial[0], removed: true } : { source: initial[0], error },
    ]);
    expect(capability.readSource).toHaveBeenCalledOnce();
  });

  it("overlaps pending source reads while yielding results in listing order", async () => {
    const first = Promise.withResolvers<undefined>();
    const secondStarted = Promise.withResolvers<undefined>();
    const sources = [
      { id: "first", fingerprint: "1" },
      { id: "second", fingerprint: "1" },
    ];
    const capability: HarnessUsageStatisticsCapability = {
      listSources: async () => sources,
      readSource: async (id) => {
        if (id === "first") {
          await first.promise;
          return [];
        }
        secondStarted.resolve(undefined);
        return [];
      },
    };
    const reading = collect(capability, sources);
    const overlapped = await Promise.race([
      secondStarted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    first.resolve(undefined);
    expect(overlapped).toBe(true);
    expect((await reading).map((item) => item.source.id)).toEqual(["first", "second"]);
  });
});
