import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ExternalSessionAccess, settleHistoryResource } from "../src/external-session-access.js";

async function fixture() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const native = adapter.sessions[0];
  if (!native) throw new Error("Fake Session is missing");
  return { adapter, native };
}

const start = {
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse("turn-1"),
  input: [{ type: "text" as const, text: "test" }],
};

describe("External Session access", () => {
  it("bounds unconfirmed cleanup without pretending it succeeded", async () => {
    vi.useFakeTimers();
    try {
      const pending = Promise.withResolvers<undefined>();
      const settling = settleHistoryResource(pending.promise);
      const rejected = expect(settling).rejects.toThrow("cleanup timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      pending.resolve(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an outstanding usage refresh counted until its actual completion", async () => {
    const { adapter, native } = await fixture();
    const pending = Promise.withResolvers<undefined>();
    vi.spyOn(native, "refreshUsage").mockReturnValue(pending.promise);
    const access = new ExternalSessionAccess(native);
    try {
      const refreshing = access.refreshUsage?.();
      expect(access.acquire()).toBeNull();
      pending.resolve(undefined);
      await refreshing;
      const lease = access.acquire();
      expect(lease).not.toBeNull();
      if (!lease) throw new Error("Expected an exclusive lease");
      await access.refreshUsage?.();
      expect(native.refreshUsage).toHaveBeenCalledOnce();
      await expect(access.execute(start)).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      await expect(access.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      access.release(lease);
      await expect(access.readSnapshot()).resolves.toMatchObject({ ok: true });
    } finally {
      pending.resolve(undefined);
      await adapter.close();
    }
  });

  it("invalidates a replacement on late output and preserves that output for its consumer", async () => {
    const { adapter, native } = await fixture();
    const access = new ExternalSessionAccess(native);
    const iterator = access.outputs[Symbol.asyncIterator]();
    const first = iterator.next();
    const lease = access.acquire();
    if (!lease) throw new Error("Expected an exclusive lease");
    try {
      // Simulate native autonomous work, bypassing this Host's public entry point.
      await native.execute(start);
      await vi.waitFor(() => expect(lease.invalidated).toBe(true));
      let delivered = false;
      void first.then(() => {
        delivered = true;
      });
      await Promise.resolve(undefined);
      expect(delivered).toBe(false);
      access.release(lease);
      await expect(first).resolves.toMatchObject({
        done: false,
        value: { kind: "event", event: { type: "turn.started" } },
      });
      expect(access.acquire()).toBeNull(); // The consumer still owns the yielded projection.
      await iterator.return?.();
      const next = access.acquire();
      expect(next).not.toBeNull();
      if (next) access.release(next);
    } finally {
      access.release(lease);
      await iterator.return?.();
      await adapter.close();
    }
  });

  it("releases call accounting after a thrown native read and blocks retired wrappers", async () => {
    const { adapter, native } = await fixture();
    const access = new ExternalSessionAccess(native);
    vi.spyOn(native, "readSnapshot").mockRejectedValueOnce(new Error("read failed"));
    try {
      await expect(access.readSnapshot()).rejects.toThrow("read failed");
      const lease = access.acquire();
      expect(lease).not.toBeNull();
      if (lease) access.release(lease);
      access.retire();
      await expect(access.execute(start)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      expect(access.acquire()).toBeNull();
    } finally {
      await adapter.close();
    }
  });
});
