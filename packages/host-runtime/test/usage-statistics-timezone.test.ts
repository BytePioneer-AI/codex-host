import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessUsageEntry } from "@codexhost/harness-adapter";
import { usageStatisticsResultSchema } from "@codexhost/shared-contracts";

import { ModelPriceCatalog } from "../src/model-prices.js";
import { UsageStatistics } from "../src/usage-statistics.js";

let directory: string;
let stats: UsageStatistics;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "usage-timezone-"));
});
afterEach(async () => {
  stats?.close();
  await rm(directory, { recursive: true, force: true });
});

async function seeded(now: string, timestamps: string[]) {
  const entries: HarnessUsageEntry[] = timestamps.map((timestamp, index) => ({
    id: String(index),
    occurredAtMs: Date.parse(timestamp),
    inputTokens: 10,
    outputTokens: 20,
  }));
  const readSource = vi.fn(async () => entries);
  stats = new UsageStatistics({
    directory,
    prices: new ModelPriceCatalog({ directory }),
    now: () => Date.parse(now),
  });
  stats.attach(() => [
    {
      harness: "pi",
      capability: {
        listSources: async () => [{ id: "one", fingerprint: "1" }],
        readSource,
      },
    },
  ]);
  await stats.get("all");
  await stats.settled();
  return readSource;
}

function hours(result: Awaited<ReturnType<UsageStatistics["get"]>>) {
  return result.hourly.map(({ weekday, hour, requests }) => [weekday, hour, requests]);
}

describe("usage statistics display timezone", () => {
  it("uses one calendar for today, daily and hourly buckets, and date filters without rereading storage", async () => {
    const readSource = await seeded("2026-09-18T17:00:00Z", [
      "2026-09-18T15:59:00Z",
      "2026-09-18T16:15:00Z",
    ]);
    const shanghai = await stats.get({ range: "today", timeZone: "Asia/Shanghai" });
    expect(usageStatisticsResultSchema.safeParse(shanghai).success).toBe(true);
    expect(shanghai).toMatchObject({
      from: "2026-09-19",
      to: "2026-09-19",
      totals: { requests: 1 },
    });
    expect(shanghai.daily).toMatchObject([{ date: "2026-09-19", requests: 1 }]);
    expect(hours(shanghai)).toEqual([[6, 0, 1]]);

    const losAngeles = await stats.get({ range: "today", timeZone: "America/Los_Angeles" });
    expect(losAngeles).toMatchObject({
      from: "2026-09-18",
      to: "2026-09-18",
      totals: { requests: 2 },
    });
    expect(hours(losAngeles)).toEqual([
      [5, 8, 1],
      [5, 9, 1],
    ]);
    const day = await stats.get({ range: "7d", timeZone: "Asia/Shanghai", date: "2026-09-18" });
    expect(day).toMatchObject({
      from: "2026-09-13",
      to: "2026-09-19",
      filters: { date: "2026-09-18" },
      totals: { requests: 1 },
    });
    expect(day.daily.map((row) => [row.date, row.requests])).toEqual([
      ["2026-09-18", 1],
      ["2026-09-19", 1],
    ]);
    expect(hours(day)).toEqual([[5, 23, 1]]);
    expect((await stats.get({ range: "today", timeZone: "Asia/Shanghai" })).hourly).toEqual(
      shanghai.hourly,
    );
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("handles skipped spring-forward hours and calendar-day ranges", async () => {
    await seeded("2026-03-09T01:00:00Z", [
      "2026-03-08T04:30:00Z",
      "2026-03-08T06:30:00Z",
      "2026-03-08T07:30:00Z",
    ]);
    const today = await stats.get({ range: "today", timeZone: "America/New_York" });
    expect(today).toMatchObject({ from: "2026-03-08", to: "2026-03-08", totals: { requests: 2 } });
    expect(hours(today)).toEqual([
      [0, 1, 1],
      [0, 3, 1],
    ]);
    expect((await stats.get({ range: "7d", timeZone: "America/New_York" })).from).toBe(
      "2026-03-02",
    );
  });

  it("combines repeated fall-back hours and keeps the previous date filter separate", async () => {
    await seeded("2026-11-02T00:30:00Z", [
      "2026-11-01T03:59:00Z",
      "2026-11-01T04:00:00Z",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
    ]);
    const today = await stats.get({ range: "today", timeZone: "America/New_York" });
    expect(today).toMatchObject({ from: "2026-11-01", to: "2026-11-01", totals: { requests: 3 } });
    expect(hours(today)).toEqual([
      [0, 0, 1],
      [0, 1, 2],
    ]);
    const previous = await stats.get({
      range: "7d",
      timeZone: "America/New_York",
      date: "2026-10-31",
    });
    expect(previous).toMatchObject({
      from: "2026-10-26",
      to: "2026-11-01",
      totals: { requests: 1 },
    });
    expect(hours(previous)).toEqual([[6, 23, 1]]);
  });

  it("supports non-whole-hour offsets and keeps legacy queries in the Host's local zone", async () => {
    const now = "2026-09-18T18:30:00Z";
    await seeded(now, ["2026-09-18T18:15:00Z"]);
    const kathmandu = await stats.get({ range: "today", timeZone: "Asia/Kathmandu" });
    expect(kathmandu.to).toBe("2026-09-19");
    expect(hours(kathmandu)).toEqual([[6, 0, 1]]);
    const legacy = await stats.get("today");
    const explicit = await stats.get({
      range: "today",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(legacy).toEqual(explicit);
  });
});
