import { describe, expect, it } from "vitest";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";

import { MuseAdapter } from "../src/muse-adapter.js";
import type { JsonObject, MuseRpc } from "../src/msp-client.js";

function lifecycleRpc(result: JsonObject): MuseRpc & { closed: boolean } {
  return {
    closed: false,
    async handshake() {
      return {};
    },
    async request() {
      return result;
    },
    notify() {},
    subscribe() {
      return () => {};
    },
    subscribeFailure() {
      return () => {};
    },
    async close() {
      this.closed = true;
    },
  };
}

const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "muse",
  nativeSessionId: "original",
  formatVersion: 1,
});

describe("Muse Session opening", () => {
  it("rejects unattended delegation before starting a native process", async () => {
    let starts = 0;
    const adapter = new MuseAdapter({
      command: process.execPath,
      createRpc: () => {
        starts += 1;
        return lifecycleRpc({ session: { sessionId: "original" } });
      },
    });
    const result = await adapter.open({
      kind: "create",
      cwd: process.cwd(),
      executionPolicy: "unattended-full-access",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported", retryable: false } });
    expect(starts).toBe(0);
    await adapter.close();
  });

  it("rejects another Harness before starting a native process", async () => {
    let starts = 0;
    const adapter = new MuseAdapter({
      command: process.execPath,
      createRpc: () => {
        starts += 1;
        return lifecycleRpc({});
      },
    });
    const result = await adapter.open({
      kind: "resume",
      cwd: process.cwd(),
      nativeRef: {
        ...nativeRef,
        harnessId: nativeSessionRefSchema.parse({ ...nativeRef, harnessId: "pi" }).harnessId,
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(starts).toBe(0);
    await adapter.close();
  });

  it("closes the native process when resume returns a different identity", async () => {
    const rpc = lifecycleRpc({ session: { sessionId: "different" } });
    const adapter = new MuseAdapter({ command: process.execPath, createRpc: () => rpc });
    const result = await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef });
    expect(result).toMatchObject({ ok: false, error: { code: "sessionNotFound" } });
    expect(rpc.closed).toBe(true);
    await adapter.close();
  });

  it.each([
    {
      session: { sessionId: "original", status: "running", activeTurnId: "old-turn" },
      pendingRequests: [],
    },
    {
      session: { sessionId: "original", status: "idle", activeTurnId: null },
      pendingRequests: [{ kind: "approval", requestId: "old-approval" }],
    },
  ])("does not silently resume an unresolved native operation as idle", async (native) => {
    const rpc = lifecycleRpc(native);
    const adapter = new MuseAdapter({ command: process.execPath, createRpc: () => rpc });
    const result = await adapter.open({ kind: "resume", cwd: process.cwd(), nativeRef });
    expect(result).toMatchObject({ ok: false, error: { code: "sessionBusy", retryable: true } });
    expect(rpc.closed).toBe(true);
    await adapter.close();
  });

  it("does not publish a Session that finishes opening after Adapter close", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rpc = lifecycleRpc({ session: { sessionId: "original" } });
    rpc.handshake = async () => {
      await ready;
      return {};
    };
    const adapter = new MuseAdapter({ command: process.execPath, createRpc: () => rpc });
    const opening = adapter.open({ kind: "create", cwd: process.cwd() });
    await Promise.resolve();
    await adapter.close();
    release();
    expect(await opening).toMatchObject({ ok: false, error: { code: "invalidState" } });
    expect(rpc.closed).toBe(true);
  });
});
