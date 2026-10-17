import { describe, expect, it } from "vitest";
import { parseHarnessAccountCredits } from "../src/account-credits.js";

describe("public quota cache validation", () => {
  it("strips only the legacy private fetch timestamp without mutating the cache", () => {
    const cached = {
      usedPercent: 0,
      limit: 0,
      periodType: "weekly",
      fetchedAt: "private cache timestamp",
    };
    expect(parseHarnessAccountCredits(cached)).toEqual({
      usedPercent: 0,
      limit: 0,
      periodType: "weekly",
    });
    expect(cached.fetchedAt).toBe("private cache timestamp");
  });
  it.each([
    null,
    undefined,
    [],
    {},
    { usedPercent: 101, periodType: "weekly" },
    { usedPercent: 1, periodType: "weekly", token: "private" },
  ])("rejects unavailable, invalid or secret-bearing snapshots: %j", (value) => {
    expect(parseHarnessAccountCredits(value)).toBeNull();
  });
});
