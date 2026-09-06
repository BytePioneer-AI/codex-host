import { describe, expect, it, vi } from "vitest";
import { AccountRateLimits } from "../src/codex-runtime/account-rate-limits.js";
import type { JsonObject } from "@codexhost/protocol-core";

const response = (usedPercent: number): JsonObject => ({
  result: { rateLimits: { primary: { usedPercent, windowDurationMins: 300 } } },
});

describe("Account quota cache", () => {
  it("isolates concurrent reads and deduplicates only within an Account", async () => {
    const cache = new AccountRateLimits();
    const pending = Promise.withResolvers<JsonObject>();
    const readA = vi.fn(() => pending.promise);
    const first = cache.refresh("a", readA);
    expect(cache.refresh("a", readA)).toBe(first);
    await cache.refresh("b", async () => response(80));
    pending.resolve(response(20));
    await first;
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(20);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
    await cache.refresh("a", readA);
    expect(readA).toHaveBeenCalledTimes(1);
  });

  it("discards a response after that Account changes and preserves other Accounts", async () => {
    const cache = new AccountRateLimits();
    const pending = Promise.withResolvers<JsonObject>();
    const old = cache.refresh("a", () => pending.promise);
    await cache.refresh("b", async () => response(80));
    cache.reset("a");
    await cache.refresh("a", async () => response(10));
    pending.resolve(response(95));
    await old;
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(10);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
  });

  it("invalidates only the notifying Account while keeping pulls authoritative", async () => {
    const cache = new AccountRateLimits();
    await cache.refresh("a", async () => response(20));
    await cache.refresh("b", async () => response(80));
    cache.observe("a", { planFiveHourUsedPercent: 99 });
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(20);
    const read = vi.fn(async () => response(30));
    await cache.refresh("a", read);
    await cache.refresh("b", read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cache.get("a")?.planFiveHourUsedPercent).toBe(30);
    expect(cache.get("b")?.planFiveHourUsedPercent).toBe(80);
  });
});
