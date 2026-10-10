import { describe, expect, it, vi } from "vitest";
import { THREAD_PREWARM_DISCARD_METHOD } from "@codexhost/shared-contracts";
import {
  createDraftPrewarmPolicyBridge,
  type RendererHostRequestBridge,
} from "../src/renderer-draft-prewarm-runtime.js";

function fixture(hostId = "local") {
  const send = vi.fn(async () => ({ discarded: true }));
  const prepare = vi.fn<(params: unknown) => Promise<unknown>>(async () => ({
    thread: { id: "draft" },
  }));
  const bridge: RendererHostRequestBridge = {
    sendRequest: send,
    prewarmThreadStart: prepare,
    enqueueRequest: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
  };
  const policy = createDraftPrewarmPolicyBridge(
    { onNotification: vi.fn(), onRequest: vi.fn(), dispatchAppServerResponse: vi.fn() },
    bridge,
    hostId,
    {},
    { discardAllPrewarmedThreads: vi.fn() },
  );
  return { bridge, policy, send, prepare };
}

describe("external draft prewarm cleanup", () => {
  it.each(["local", "remote-ssh-codex-managed:test"])(
    "discards only marked, unused prewarms on %s",
    async (hostId) => {
      const f = fixture(hostId);
      f.policy.select("codexhost/claude-code-native");
      await f.bridge.prewarmThreadStart({ cwd: "/project" });
      expect(f.prepare).toHaveBeenCalledWith({
        cwd: "/project",
        model: "codexhost/claude-code-native",
        codexhostPrewarm: true,
      });
      await f.policy.clear();
      await f.policy.clear();
      expect(f.send).toHaveBeenCalledExactlyOnceWith(THREAD_PREWARM_DISCARD_METHOD, {
        threadId: "draft",
      });
      f.policy.dispose();
    },
  );

  it("cleans up a late external result after disposal", async () => {
    const f = fixture();
    const result = Promise.withResolvers<unknown>();
    f.prepare.mockReturnValueOnce(result.promise);
    f.policy.select("codexhost/claude-code-native");
    const pending = f.bridge.prewarmThreadStart({}) as Promise<unknown>;
    f.policy.dispose();
    result.resolve({ thread: { id: "late" } });
    await expect(pending).rejects.toThrow("invalidated");
    expect(f.send).toHaveBeenCalledWith(THREAD_PREWARM_DISCARD_METHOD, { threadId: "late" });
  });

  it("does not discard a prewarm already submitted", async () => {
    const f = fixture();
    f.policy.select("codexhost/claude-code-native");
    await f.bridge.prewarmThreadStart({});
    await f.bridge.sendRequest("turn/start", { threadId: "draft", input: [] });
    await f.policy.clear();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.policy.dispose();
  });

  it("does not mark or discard official and ephemeral prewarms", async () => {
    const f = fixture();
    await f.bridge.prewarmThreadStart({ model: "gpt-5" });
    f.policy.select("codexhost/claude-code-native");
    await f.bridge.prewarmThreadStart({ ephemeral: true, model: "gpt-5" });
    await f.policy.clear();
    expect(f.prepare.mock.calls).toEqual([
      [{ model: "gpt-5" }],
      [{ ephemeral: true, model: "gpt-5" }],
    ]);
    expect(f.send).not.toHaveBeenCalled();
    f.policy.dispose();
  });

  it("keeps configuration changes usable when cleanup cannot reach the Host", async () => {
    const f = fixture();
    f.send.mockRejectedValue(new Error("disconnected"));
    f.policy.select("codexhost/claude-code-native");
    await f.bridge.prewarmThreadStart({});
    await expect(f.policy.clear()).resolves.toBeUndefined();
    f.policy.dispose();
  });
});
