import { describe, expect, it, vi } from "vitest";
import { retainNativeRpcInteractions } from "../src/renderer-native-rpc-interactions.js";
import type {
  NativeRpcManager,
  NativeRpcResult,
  NativeOwnedManager,
} from "../src/renderer-native-rpc-contracts.js";

function result<T>(value: T | Promise<T>): NativeRpcResult<T> {
  return Object.assign(Promise.resolve(value), { onRpcBroken: vi.fn(), [Symbol.dispose]: vi.fn() });
}
function fixture() {
  const listeners = new Map<string, (value: unknown) => void>();
  const leases: { [Symbol.dispose](): void }[] = [];
  const rpc: NativeRpcManager = {
    dup: () => rpc,
    onRpcBroken: vi.fn(),
    [Symbol.dispose]: vi.fn(),
    getCodexHome: vi.fn(() => result("C:\\Users\\test\\.codex")),
    sendRequest: vi.fn(() => result({})),
    getWorkInProgress: vi.fn(() => result([])),
    getConversation: vi.fn(() => result({ requests: [] })),
    subscribe: vi.fn((input) => {
      listeners.set(input.type === "event" ? input.event : input.methods.join(","), input.listener);
      const lease = { onRpcBroken: vi.fn(), [Symbol.dispose]: vi.fn() };
      const pending = result(lease);
      leases.push(lease, pending);
      return pending;
    }),
  };
  const manager = { onRequest: vi.fn() } as unknown as NativeOwnedManager;
  const request = (id: number) => ({
    id,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", command: "echo marker" },
  });
  return { rpc, manager, listeners, leases, request };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("native RPC interaction handoff", () => {
  it("recovers pending approvals and forwards each native request once without submitting turns", async () => {
    const f = fixture();
    const first = f.request(1),
      second = f.request(2);
    vi.mocked(f.rpc.getWorkInProgress).mockReturnValue(
      result([{ conversationId: "thread" }, { conversationId: "thread" }]),
    );
    vi.mocked(f.rpc.getConversation).mockReturnValue(result({ requests: [first] }));
    const bridge = retainNativeRpcInteractions(f.rpc, f.manager, "remote-control:windows");
    await bridge.ready;
    expect(f.manager.onRequest).toHaveBeenCalledExactlyOnceWith(first);
    f.listeners.get("approval-request")?.({ conversationId: "thread", requestId: 1 });
    await flush();
    expect(f.manager.onRequest).toHaveBeenCalledOnce();
    vi.mocked(f.rpc.getConversation).mockReturnValue(
      result({ requests: [first, second, { ...f.request(3), params: { threadId: "another" } }] }),
    );
    f.listeners.get("user-input-request")?.({ conversationId: "thread", requestId: 2 });
    await flush();
    expect(f.manager.onRequest).toHaveBeenCalledTimes(2);
    expect(f.manager.onRequest).toHaveBeenLastCalledWith(second);
    expect(f.rpc.sendRequest).not.toHaveBeenCalled();
    bridge.dispose();
    for (const lease of f.leases) expect(lease[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("does not resurrect a request resolved while its conversation snapshot was in flight", async () => {
    const f = fixture();
    const bridge = retainNativeRpcInteractions(f.rpc, f.manager, "remote-control:windows");
    await bridge.ready;
    let resolve: (value: unknown) => void = () => {};
    vi.mocked(f.rpc.getConversation)
      .mockReturnValueOnce(
        result(
          new Promise((done) => {
            resolve = done;
          }),
        ),
      )
      .mockReturnValue(result({ requests: [] }));
    f.listeners.get("approval-request")?.({ conversationId: "thread", requestId: 1 });
    await flush();
    f.listeners.get("serverRequest/resolved")?.({
      method: "serverRequest/resolved",
      params: { threadId: "thread", requestId: 1 },
    });
    resolve({ requests: [f.request(1)] });
    await flush();
    expect(f.rpc.getConversation).toHaveBeenCalledTimes(2);
    expect(f.manager.onRequest).not.toHaveBeenCalled();
    await flush();
    expect(f.rpc.getConversation).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });

  it("drops late snapshots and ignores events after the owning connection retires", async () => {
    const f = fixture();
    const bridge = retainNativeRpcInteractions(f.rpc, f.manager, "remote-control:windows");
    await bridge.ready;
    let resolve: (value: unknown) => void = () => {};
    const pending = result(
      new Promise((done) => {
        resolve = done;
      }),
    );
    vi.mocked(f.rpc.getConversation).mockReturnValue(pending);
    f.listeners.get("approval-request")?.({ conversationId: "thread", requestId: 1 });
    await flush();
    bridge.dispose();
    resolve({ requests: [f.request(1)] });
    await flush();
    f.listeners.get("approval-request")?.({ conversationId: "thread", requestId: 2 });
    await flush();
    expect(f.rpc.getConversation).toHaveBeenCalledOnce();
    expect(pending[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(f.manager.onRequest).not.toHaveBeenCalled();
  });
});
