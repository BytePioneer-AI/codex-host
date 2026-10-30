import { afterEach, expect, it, vi } from "vitest";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "../src/renderer-model-client.js";
import type { RendererMessageTarget } from "../src/renderer-manual-compaction.js";
import { restoreThreadReferenceCapability } from "../src/renderer-thread-reference-capability.js";

const input = { threadId: hostThreadIdSchema.parse("historical") };
const key = "thread-reference-capability:historical";
const proof = { owner: "codex", locked: true, supportsThreadReferences: true };
type Listener = Parameters<RendererMessageTarget["addEventListener"]>[1];
function fixture(value?: boolean) {
  const state: Record<string, unknown> = value === undefined ? {} : { [key]: value };
  const listeners = new Set<Listener>();
  let current = true;
  let respond = true;
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.type === "persisted-atom-sync-request" && respond) {
      for (const listener of listeners) {
        listener({ source: messages, data: { type: "persisted-atom-sync", state: { ...state } } });
      }
    }
    if (message.type === "persisted-atom-update") state[String(message.key)] = message.value;
  });
  const messages = {
    electronBridge: { sendMessageFromView: send },
    addEventListener: (_: "message", listener: Listener) => listeners.add(listener),
    removeEventListener: (_: "message", listener: Listener) => listeners.delete(listener),
  };
  const inspect = vi.fn().mockResolvedValue(proof);
  const original = Object.freeze({ inspectThread: inspect }) as unknown as RendererModelClient;
  const manager = Object.freeze({ kind: "main-process-rpc", sendRequest: vi.fn() });
  const client = restoreThreadReferenceCapability(original, manager, () => current, messages);
  return {
    client,
    inspect,
    send,
    state,
    listeners,
    messages,
    retire: () => {
      current = false;
    },
    silence: () => {
      respond = false;
    },
  };
}
afterEach(() => vi.useRealTimers());

it("backfills via native persistence messages, not an RPC storage property", async () => {
  const f = fixture();
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledWith({ ...input, includeReferenceCapability: true });
  expect(f.send).toHaveBeenLastCalledWith({
    type: "persisted-atom-update",
    key,
    value: true,
    deleted: false,
  });
  expect(f.state[key]).toBe(true);
  expect(f.listeners.size).toBe(0);
});

it.each([false, true])("preserves explicit native %s", async (value) => {
  const f = fixture(value);
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledWith(input);
  expect(f.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "persisted-atom-update" }),
  );
});

it.each(["retired", "false"])("rechecks state and connection after proof: %s", async (reason) => {
  const f = fixture();
  f.inspect.mockImplementation(async () => {
    if (reason === "retired") f.retire();
    else f.state[key] = false;
    return proof;
  });
  await f.client.inspectThread(input);
  expect(f.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "persisted-atom-update" }),
  );
});

it.each([
  { owner: "codex", locked: true },
  { ...proof, owner: "external" },
])("requires native ownership and Host proof: %j", async (result) => {
  const f = fixture();
  f.inspect.mockResolvedValue(result);
  await f.client.inspectThread(input);
  await f.client.inspectThread(input);
  expect(f.inspect.mock.calls.filter(([params]) => params.includeReferenceCapability)).toHaveLength(
    1,
  );
  expect(f.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "persisted-atom-update" }),
  );
});

it("falls back once for old Hosts", async () => {
  const f = fixture();
  f.inspect.mockRejectedValueOnce(new Error("Invalid params"));
  await f.client.inspectThread(input);
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledTimes(3);
  expect(f.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "persisted-atom-update" }),
  );
});

it("reserves the one-time check before waiting for a native snapshot", async () => {
  const f = fixture();
  f.silence();
  const first = f.client.inspectThread(input);
  await f.client.inspectThread(input);
  for (const listener of f.listeners) {
    listener({
      source: f.messages,
      data: { type: "persisted-atom-sync", state: { [key]: false } },
    });
  }
  await first;
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(f.inspect).not.toHaveBeenCalledWith(
    expect.objectContaining({ includeReferenceCapability: true }),
  );
});

it("rechecks the connection after the final asynchronous snapshot", async () => {
  const f = fixture();
  f.inspect.mockImplementation(async () => {
    f.silence();
    return proof;
  });
  const pending = f.client.inspectThread(input);
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(2));
  f.retire();
  for (const listener of f.listeners) {
    listener({ source: f.messages, data: { type: "persisted-atom-sync", state: {} } });
  }
  await pending;
  expect(f.send).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "persisted-atom-update" }),
  );
  expect(f.listeners.size).toBe(0);
});

it("times out without proof or writes, removes listeners, and does not poll", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.silence();
  const pending = f.client.inspectThread(input);
  for (const listener of f.listeners) {
    listener({ source: {}, data: { type: "persisted-atom-sync", state: {} } });
    listener({ source: f.messages, data: { type: "persisted-atom-sync", state: null } });
  }
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toEqual(proof);
  await f.client.inspectThread(input);
  expect(f.inspect).toHaveBeenCalledWith(input);
  expect(f.inspect).not.toHaveBeenCalledWith(
    expect.objectContaining({ includeReferenceCapability: true }),
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.listeners.size).toBe(0);
});

it.each(["read", "write"])(
  "preserves ownership inspection when native %s rejects",
  async (phase) => {
    const f = fixture();
    if (phase === "read") f.send.mockRejectedValue(new Error("bridge unavailable"));
    else
      f.send.mockImplementation(async (message) => {
        if (message.type === "persisted-atom-update") throw new Error("write unavailable");
        for (const listener of f.listeners) {
          listener({ source: f.messages, data: { type: "persisted-atom-sync", state: {} } });
        }
      });
    await expect(f.client.inspectThread(input)).resolves.toEqual(proof);
    if (phase === "read") expect(f.inspect).toHaveBeenCalledWith(input);
    else expect(f.inspect).toHaveBeenCalledWith({ ...input, includeReferenceCapability: true });
    expect(f.listeners.size).toBe(0);
  },
);
