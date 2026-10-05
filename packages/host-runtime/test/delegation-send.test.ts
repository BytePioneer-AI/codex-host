import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhenIdle } from "../src/delegation-send.js";
import { DelegationControlError } from "../src/delegation-types.js";

afterEach(() => vi.useRealTimers());
const busy = () => new DelegationControlError("THREAD_BUSY", "active Turn");

describe("send after idle", () => {
  it("waits for active work, survives an admission race, and delivers only once", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue({ turnId: "new-turn" });
    const wait = vi.fn(async () => ({}));
    await expect(sendWhenIdle({ send, wait, timeoutMs: 5000 })).resolves.toEqual({
      turnId: "new-turn",
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary sends immediate", async () => {
    const wait = vi.fn();
    await expect(
      sendWhenIdle({
        send: async () => {
          throw busy();
        },
        wait,
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not resend when acceptance is unknown or the target disappears", async () => {
    for (const code of ["RUNTIME_UNREACHABLE", "DELEGATION_FAILED", "THREAD_NOT_FOUND"] as const) {
      const send = vi.fn(async () => {
        throw new DelegationControlError(code, "unknown");
      });
      const wait = vi.fn();
      await expect(sendWhenIdle({ send, wait, timeoutMs: 5000 })).rejects.toMatchObject({ code });
      expect(send).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    }
  });

  it("expires without a late send or a retained queue", async () => {
    const send = vi.fn(async () => {
      throw busy();
    });
    const wait = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    await expect(sendWhenIdle({ send, wait, timeoutMs: 10 })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      details: { notDelivered: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports non-delivery when the idle read aborts at the deadline", async () => {
    const send = vi.fn(async () => {
      throw busy();
    });
    const wait = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new DelegationControlError("RUNTIME_UNREACHABLE", "read aborted");
    });
    await expect(sendWhenIdle({ send, wait, timeoutMs: 10 })).rejects.toMatchObject({
      code: "THREAD_BUSY",
      details: { notDelivered: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
