import { afterEach, describe, expect, it, vi } from "vitest";
import { installCurrentRendererAdapter } from "../src/versioned-renderer-adapter.js";

afterEach(() => vi.unstubAllGlobals());

describe("native RPC steering readiness", () => {
  it("reports a missing native submission binding without holding aggregate readiness", () => {
    const manager = Object.freeze({ kind: "main-process-rpc", sendRequest: vi.fn() });
    const route = {
      hostId: "local",
      manager,
      policy: { state: "ready", hostId: "local", select: vi.fn(), clear: vi.fn() },
    };
    const listeners = new Map<string, () => void>();
    const fakeWindow: Record<string, unknown> = {
      __codexhostHostRoutingV1: {
        forComposer: () => route,
        forHost: () => route,
        knownHostIds: () => ["local"],
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn((type: string, listener: () => void) =>
        listeners.set(type, listener),
      ),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 0),
      clearInterval: vi.fn(),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(),
      documentElement: {},
    });
    vi.stubGlobal(
      "CustomEvent",
      class {
        constructor(readonly type: string) {}
      },
    );
    const adapter = installCurrentRendererAdapter();
    try {
      expect(adapter.status).toMatchObject({
        state: "ready",
        reason: "native-steering-policy-unavailable",
      });
      fakeWindow.__codexhostRpcSteeringV1 = { controller: {} };
      listeners.get("codexhost:draft-prewarm-policy-changed")?.();
      expect(adapter.status).toMatchObject({ state: "ready", reason: "ready" });
      delete fakeWindow.__codexhostRpcSteeringV1;
      listeners.get("codexhost:draft-prewarm-policy-changed")?.();
      expect(adapter.status).toMatchObject({
        state: "ready",
        reason: "native-steering-policy-unavailable",
      });
    } finally {
      adapter.dispose();
    }
  });
});
