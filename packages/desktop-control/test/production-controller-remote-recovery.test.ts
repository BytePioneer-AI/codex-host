import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { runDesktopController } from "../src/production-controller.js";
import type { RendererCdpControlSession } from "../src/renderer-cdp-control-session.js";
import type { RemoteSessionTarget } from "../src/renderer-remote-sessions.js";

const options = {
  rendererCdpEndpoint: "http://127.0.0.1:1",
  rendererPath: "/fixture-renderer.js",
  attachmentPort: 12345,
  attachmentNonce: "0123456789abcdef0123456789abcdef",
};

it("restores enabled connections at Controller startup and after backoff without Web requests", async () => {
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const abort = new AbortController();
  const hostId = "remote-ssh-discovered:startup";
  let state = "disconnected";
  let error: string | null = null;
  const connect = vi.fn(async () => {
    if (connect.mock.calls.length === 1) {
      error = "ECONNREFUSED";
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: error });
    }
    state = "connected";
    error = null;
  });
  const target: RemoteSessionTarget = {
    __codexhostHostRoutingV1: {
      knownHostIds: () => [hostId],
      forHost: () => (state === "connected" ? { manager: { sendRequest() {} } } : null),
    },
    __codexhostRendererBindingProbeV1: {
      async remoteConnections(input) {
        switch ((input as { action: string }).action) {
          case "catalog":
            return [{ hostId, displayName: "startup", autoConnect: true }];
          case "state":
            return { state, error };
          default:
            return connect();
        }
      },
    },
  };
  const snapshot = {} as RendererCdpControlSession["snapshot"];
  const evaluate = vi.fn((expression: string) =>
    new Function("window", `return ${expression}`)(target),
  );
  const close = vi.fn();
  const session: RendererCdpControlSession = {
    snapshot,
    ensureInstalled: vi.fn(async () => snapshot),
    activateDesktop: vi.fn(async () => 1),
    executeRenderer: evaluate,
    close,
  };
  let cycles = 0;
  const serverClose = vi.fn(async () => {});
  try {
    await runDesktopController(options, abort.signal, {
      readRenderer: async () => "fixture renderer",
      install: async () => session,
      startAttachmentServer: async () => ({ close: serverClose }),
      ready() {},
      now: () => now,
      monitorIntervalMs: 1,
      async sleep() {
        await setImmediate();
        cycles++;
        if (cycles === 1) {
          expect(connect).toHaveBeenCalledTimes(1);
          now = 4_999;
        } else if (cycles === 2) {
          expect(connect).toHaveBeenCalledTimes(1);
          now = 5_000;
        } else {
          expect(connect).toHaveBeenCalledTimes(2);
          expect(state).toBe("connected");
          abort.abort();
        }
      },
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
    await setImmediate();
    expect(evaluate).toHaveBeenCalledTimes(2);
  } finally {
    abort.abort();
    clock.mockRestore();
  }
});

it("coalesces pending recovery evaluations without blocking monitoring and closes them on exit", async () => {
  const abort = new AbortController();
  let now = 0;
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => {
    reject = fail;
  });
  const executeRenderer = vi.fn(() => pending);
  const ensureInstalled = vi.fn(async () => snapshot);
  const snapshot = {} as RendererCdpControlSession["snapshot"];
  const close = vi.fn(() => reject(new Error("CDP closed")));
  const session: RendererCdpControlSession = {
    snapshot,
    ensureInstalled,
    activateDesktop: vi.fn(async () => 1),
    executeRenderer,
    close,
  };
  let cycles = 0;
  await runDesktopController(options, abort.signal, {
    readRenderer: async () => "fixture renderer",
    install: async () => session,
    startAttachmentServer: async () => ({ close: async () => {} }),
    ready() {},
    now: () => now,
    monitorIntervalMs: 1,
    async sleep() {
      await setImmediate();
      now += 5_000;
      if (++cycles === 3) abort.abort();
    },
  });
  await setImmediate();
  expect(ensureInstalled).toHaveBeenCalledTimes(2);
  expect(executeRenderer).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
