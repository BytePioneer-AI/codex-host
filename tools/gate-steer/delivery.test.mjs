import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSteerDelivery } from "./delivery.mjs";

afterEach(() => vi.useRealTimers());
const answer = (turnId, itemId = "reply") => ({
  type: "item.completed",
  turnId,
  snapshot: { item: { type: "agentMessage", itemId, text: "STEER_MARKER" } },
});
const terminal = (turnId) => ({ type: "turn.completed", turnId, outcome: { status: "succeeded" } });

describe("native steer delivery observation", () => {
  it("records a following-Turn delivery distinctly without stopping observation early", async () => {
    vi.useFakeTimers();
    const events = [terminal("original")];
    const result = observeSteerDelivery(() => events, "STEER_MARKER", "original");
    await vi.advanceTimersByTimeAsync(10_000);
    events.push(answer("next"), terminal("next"));
    let finished = false;
    void result.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).replies).toEqual([
      expect.objectContaining({
        turnId: "next",
        placement: "followingTurn",
        outcome: { status: "succeeded" },
      }),
    ]);
  });

  it("retains duplicate replies across Turns and does not infer delivery from completion alone", async () => {
    vi.useFakeTimers();
    const events = [answer("original"), terminal("original")];
    const result = observeSteerDelivery(() => events, "STEER_MARKER", "original");
    await vi.advanceTimersByTimeAsync(10_000);
    events.push(answer("next"), terminal("next"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await result).replies).toHaveLength(2);
    const missing = observeSteerDelivery(() => [terminal("original")], "STEER_MARKER", "original");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await missing).replies).toEqual([]);
  });

  it("does not treat an unfinished reply as a completed delivery", async () => {
    vi.useFakeTimers();
    const result = observeSteerDelivery(() => [answer("original")], "STEER_MARKER", "original");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).replies).toEqual([expect.objectContaining({ outcome: undefined })]);
  });
});
