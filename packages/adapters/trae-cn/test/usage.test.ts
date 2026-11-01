import { describe, expect, it } from "vitest";
import { nativeContextUsage, contextUsageFromHistory } from "../src/usage.js";

describe("TRAE CN native context occupancy", () => {
  it("does not present the latest model request or placeholder totals as Session consumption", () => {
    expect(
      nativeContextUsage({
        prompt_tokens: 25847,
        completion_tokens: 53,
        total_tokens: 25900,
        prompt_tokens_total: 0,
        completion_tokens_total: 0,
        last_turn_total_tokens: 25900,
        max_tokens: 116000,
        input: "0.000",
        output: "0.000",
      }),
    ).toEqual({
      contextUsedTokens: 25900,
      contextWindowTokens: 116000,
      contextUsagePercent: (100 * 25900) / 116000,
    });
  });
  it("requires both native context counters and preserves an explicit zero", () => {
    for (const value of [
      undefined,
      {},
      { max_tokens: 100 },
      { last_turn_total_tokens: 0 },
      { last_turn_total_tokens: -1, max_tokens: 100 },
      { last_turn_total_tokens: 10, max_tokens: 0 },
      { last_turn_total_tokens: "10", max_tokens: 100 },
    ])
      expect(nativeContextUsage(value)).toBeNull();
    expect(nativeContextUsage({ last_turn_total_tokens: 0, max_tokens: 100 })).toMatchObject({
      contextUsedTokens: 0,
      contextUsagePercent: 0,
    });
  });
  it("uses the latest native assistant in history order without borrowing another active Turn's data", () => {
    const item = (message_index: number, reply_to_message_id: string, n: number) => ({
      message_index,
      reply_to_message_id,
      role: "assistant",
      tokenUsage: { last_turn_total_tokens: n, max_tokens: 1000 },
    });
    const value = { items: [item(4, "new", 400), item(2, "old", 200)] };
    expect(contextUsageFromHistory(value)).toMatchObject({ contextUsedTokens: 400 });
    expect(contextUsageFromHistory(value, "old")).toMatchObject({ contextUsedTokens: 200 });
    expect(contextUsageFromHistory(value, "pending")).toBeNull();
    expect(
      contextUsageFromHistory({ items: [...value.items, { message_index: 6, role: "assistant" }] }),
    ).toBeNull();
  });
});
