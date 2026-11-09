import { describe, expect, it, vi } from "vitest";
import { encodeHarnessPluginRoute, harnessPluginRouteSchema } from "@codexhost/shared-contracts";
import {
  createDraftPrewarmPolicyBridge,
  type RendererHostRequestBridge,
} from "../src/renderer-draft-prewarm-runtime.js";

function route(harnessId: string, model: string): string {
  return encodeHarnessPluginRoute(
    harnessPluginRouteSchema.parse({ harnessId, model: { id: model } }),
  );
}

describe("explicit Harness routes through the Desktop request bridge", () => {
  it.each([
    ["claude-code", "pi"],
    ["pi", "claude-code"],
    ["pi", "pi"],
    [null, "pi"],
  ])("preserves the caller's %s → %s route and configuration", async (desktop, requested) => {
    const sendRequest = vi.fn(async () => ({}));
    const bridge: RendererHostRequestBridge = {
      sendRequest,
      prewarmThreadStart: vi.fn(async () => ({})),
      enqueueRequest: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    };
    const policy = createDraftPrewarmPolicyBridge(
      { onNotification: vi.fn(), onRequest: vi.fn(), dispatchAppServerResponse: vi.fn() },
      bridge,
      "local",
      {},
      { discardAllPrewarmedThreads: vi.fn() },
    );
    try {
      policy.select(desktop === null ? null : route(desktop, "desktop-model"));
      const params = {
        cwd: "/workspace",
        model: encodeHarnessPluginRoute(
          harnessPluginRouteSchema.parse({
            harnessId: requested,
            model: { id: "web-model" },
            thinkingOptionId: "high",
            permissionModeId: "ask",
          }),
        ),
      };
      const options = { timeoutMs: 1_000 };
      await bridge.sendRequest("thread/start", params, options);
      expect(sendRequest).toHaveBeenCalledExactlyOnceWith("thread/start", params, options);
      // Caller-owned routes do not change the selection or rewrite official requests.
      expect(policy.select(desktop === null ? null : route(desktop, "desktop-model"))).toBe(false);
      await bridge.sendRequest("thread/start", { model: "gpt-5" });
      expect(sendRequest).toHaveBeenLastCalledWith("thread/start", { model: "gpt-5" });
    } finally {
      policy.dispose();
    }
  });
});
