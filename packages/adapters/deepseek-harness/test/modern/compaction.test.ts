import { describe, expect, it } from "vitest";

import { modernCompactionOutcome, withModernContextPressure } from "../../src/modern/compaction.js";

const usage = {
  inputTokens: 100,
  outputTokens: 20,
  contextUsedTokens: 100,
  contextWindowTokens: 200,
};

describe("DSH native context pressure", () => {
  it("uses projected occupancy without resetting cumulative consumption", () => {
    expect(
      withModernContextPressure(usage, {
        seq: 7,
        value: { pressureTokens: 100, projectedTokens: 25, contextWindow: 200 },
      }),
    ).toEqual({ ...usage, contextUsedTokens: 25 });
  });

  it("supports older projections without projectedTokens and occupancy without usage", () => {
    expect(
      withModernContextPressure(null, {
        seq: 1,
        value: { pressureTokens: 30, contextWindow: 200 },
      }),
    ).toEqual({ contextUsedTokens: 30, contextWindowTokens: 200 });
  });

  it("retains zero occupancy instead of falling back to pre-compaction pressure", () => {
    expect(
      withModernContextPressure(usage, {
        seq: 2,
        value: { pressureTokens: 100, projectedTokens: 0, contextWindow: 200 },
      }),
    ).toEqual({ ...usage, contextUsedTokens: 0 });
  });

  it.each([
    null,
    {},
    { projectedTokens: -1, contextWindow: 200 },
    { projectedTokens: 1.5, contextWindow: 200 },
    { projectedTokens: 10, contextWindow: 0 },
  ])("does not fabricate occupancy from an unavailable or malformed view %j", (value) => {
    expect(withModernContextPressure(usage, { seq: 1, value })).toBe(usage);
  });

  it("preserves usage when the optional projection is absent", () => {
    expect(withModernContextPressure(usage, undefined)).toBe(usage);
  });

  it("keeps compaction failure local rather than inventing Turn cancellation", () => {
    expect(modernCompactionOutcome({ error: "summary failed" })).toMatchObject({
      status: "failed",
      error: { message: "summary failed" },
    });
    expect(modernCompactionOutcome({})).toEqual({ status: "succeeded" });
  });
});
