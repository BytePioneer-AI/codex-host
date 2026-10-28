import { describe, it, expect, vi } from "vitest";
import { GatewayTransportPool } from "../src/gateway-transport-pool.js";
import { HermesGatewayTransport } from "../src/gateway-transport.js";

function fakeTransport(
  runtime: string | { launcher: string },
  overrides: Partial<{
    closed: boolean;
    started: boolean;
  }> = {},
) {
  const transport = new HermesGatewayTransport(
    typeof runtime === "string" ? runtime : runtime,
    process.cwd(),
    {},
  );
  const start = vi.spyOn(transport, "start").mockResolvedValue();
  const close = vi.spyOn(transport, "close").mockResolvedValue();
  // Reflect pool-relevant state without spawning anything.
  let started = overrides.started ?? true;
  let closed = overrides.closed ?? false;
  Object.defineProperty(transport, "started", { get: () => started });
  Object.defineProperty(transport, "closed", { get: () => closed });
  return {
    transport,
    start,
    close,
    setClosed: (value: boolean) => (closed = value),
    setStarted: (value: boolean) => (started = value),
  };
}

describe("GatewayTransportPool", () => {
  it("returns null from an empty pool", () => {
    const pool = new GatewayTransportPool();
    expect(pool.acquire({ launcher: "/hermes" })).toBeNull();
  });

  it("hands a released bridge to the next matching acquire", () => {
    const pool = new GatewayTransportPool();
    const first = fakeTransport({ launcher: "/hermes" });
    pool.release(first.transport);
    const acquired = pool.acquire({ launcher: "/hermes" });
    expect(acquired).toBe(first.transport);
    expect(first.close).not.toHaveBeenCalled();
    // Acquired once: the pool is empty again.
    expect(pool.acquire({ launcher: "/hermes" })).toBeNull();
  });

  it("discards a bridge that faulted while idle", async () => {
    const pool = new GatewayTransportPool();
    const bridge = fakeTransport({ launcher: "/hermes" });
    pool.release(bridge.transport);
    bridge.setClosed(true);
    expect(pool.acquire({ launcher: "/hermes" })).toBeNull();
    // Give the discarded close a tick to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(bridge.close).toHaveBeenCalled();
  });

  it("discards a bridge that never started", async () => {
    const pool = new GatewayTransportPool();
    const bridge = fakeTransport({ launcher: "/hermes" }, { started: false });
    pool.release(bridge.transport);
    expect(pool.acquire({ launcher: "/hermes" })).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(bridge.close).toHaveBeenCalled();
  });

  it("does not hand a bridge to a different runtime", () => {
    const pool = new GatewayTransportPool();
    const bridge = fakeTransport({ launcher: "/hermes" });
    pool.release(bridge.transport);
    expect(pool.acquire({ launcher: "/other" })).toBeNull();
    expect(pool.acquire("/hermes")).toBeNull();
    // The mismatched bridge stays pooled for its own runtime.
    expect(pool.acquire({ launcher: "/hermes" })).toBe(bridge.transport);
  });

  it("closes surplus bridges beyond capacity", async () => {
    const pool = new GatewayTransportPool(1);
    const first = fakeTransport({ launcher: "/hermes" });
    const second = fakeTransport({ launcher: "/hermes" });
    pool.release(first.transport);
    pool.release(second.transport);
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.close).toHaveBeenCalled();
    expect(pool.acquire({ launcher: "/hermes" })).toBe(first.transport);
  });

  it("close() tears down every pooled bridge", async () => {
    const pool = new GatewayTransportPool();
    const first = fakeTransport({ launcher: "/hermes" });
    const second = fakeTransport({ launcher: "/hermes" });
    pool.release(first.transport);
    pool.release(second.transport);
    await pool.close();
    expect(first.close).toHaveBeenCalled();
    expect(second.close).toHaveBeenCalled();
    expect(pool.acquire({ launcher: "/hermes" })).toBeNull();
  });
});
