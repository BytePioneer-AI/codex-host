import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { NativeConnection, unwrap } = createRequire(import.meta.url)(
  "../assets/companion/native.cjs",
);

interface Message {
  id?: string | number;
  method?: string;
  params?: unknown[];
  result?: unknown;
}

class Channel extends EventEmitter {
  sent: Message[] = [];
  disconnected = false;
  handle?: (message: Message) => void;
  send(raw: string) {
    const message: Message = JSON.parse(raw);
    this.sent.push(message);
    this.handle?.(message);
  }
  receive(message: unknown) {
    this.emit("message", JSON.stringify(message));
  }
  disconnect() {
    this.disconnected = true;
    this.emit("disconnect");
  }
}

function setup(timeoutMs = 1000) {
  const channel = new Channel();
  const executeCommand = vi.fn(async (name: string) =>
    name === "icube.common.getUserInfo"
      ? { token: "fixture-token", userId: "fixture-user", account: { scope: "marscode" } }
      : { configuration: true },
  );
  const vscode = {
    commands: { executeCommand },
    workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
    env: { machineId: "fixture-device", language: "zh-CN" },
  };
  return {
    channel,
    executeCommand,
    native: new NativeConnection(channel, vscode, "window", timeoutMs),
  };
}

describe("TRAE CN app-owned native RPC", () => {
  it("unwraps desktop and lite envelopes and rejects inner errors", () => {
    expect(
      unwrap({
        packet_type: "response",
        params: { code: 0, data: { code: 0, data: { id: "native" } } },
      }),
    ).toEqual({ id: "native" });
    expect(() => unwrap({ code: 0, data: { code: 404, message: "Session missing" } })).toThrow(
      "Session missing",
    );
    expect(() => unwrap({ packet_type: "response", params: "invalid type: string" })).toThrow(
      "non-JSON",
    );
  });

  it("uses the current app login and object data on every native request", async () => {
    const { channel, executeCommand, native } = setup();
    channel.handle = (message) =>
      channel.receive({
        jsonrpc: "2.0",
        id: message.id,
        result: { packet_type: "response", params: { code: 0, data: { models: [] } } },
      });
    await expect(native.call("model", "model_list", { function: "chat" })).resolves.toEqual({
      models: [],
    });
    expect(channel.sent[0]?.params?.[0]).toMatchObject({
      params: {
        data: { function: "chat" },
        user_info: { token: "fixture-token" },
        client_info: {
          permission_profile_id: "manual_approval",
          workspace_folders: ["/workspace"],
        },
      },
    });
    await native.call("healthcheck", "ping");
    expect(executeCommand).toHaveBeenCalledTimes(2);
    native.close();
    expect(channel.disconnected).toBe(true);
  });

  it("registers a stream before immediately following native data, including batches", async () => {
    const { channel, native } = setup();
    const data = vi.fn(),
      end = vi.fn(),
      error = vi.fn();
    channel.handle = (message) => {
      if (message.method !== "request_stream") return;
      channel.receive([
        { jsonrpc: "2.0", id: message.id, result: { streamId: "stream" } },
        {
          jsonrpc: "2.0",
          method: "rpc.stream.stream",
          meta: { stream: true, streamId: "stream", chunkIndex: 0 },
          params: {
            data: { packet_type: "response", params: { code: 0, data: { event: "metadata" } } },
          },
        },
        {
          jsonrpc: "2.0",
          method: "rpc.stream.stream",
          meta: { stream: true, streamId: "stream", done: true },
          params: { data: null },
        },
      ]);
    };
    await native.subscribe(
      "lite",
      "subscribe_events",
      { chat_session_id: "session" },
      {},
      { data, end, error },
    );
    expect(data).toHaveBeenCalledExactlyOnceWith({ event: "metadata" });
    expect(end).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    native.close();
  });

  it("responds to callback ID zero and rejects commands outside the read allowlist", async () => {
    const { channel, executeCommand, native } = setup();
    channel.receive({
      jsonrpc: "2.0",
      id: 0,
      method: "execute_command",
      params: [{ channel_id: "callback", params: { command_id: "icube.common.getDynamicConfig" } }],
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]).toMatchObject({
      id: 0,
      result: { results: { payload: '{"configuration":true}' } },
    });
    channel.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "execute_command",
      params: [
        {
          channel_id: "denied",
          params: { command_id: "workbench.action.closeWindow", args: ['"secret-fixture"'] },
        },
      ],
    });
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2));
    expect(channel.sent[1]).toMatchObject({
      result: { results: { error: "Desktop callback is not supported by this bridge" } },
    });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(channel.sent)).not.toContain("secret-fixture");
    native.close();
  });

  it("detaches an observer without sending the native generation cancel notification", async () => {
    const { channel, native } = setup();
    channel.handle = (message) => {
      if (message.method === "request_stream")
        channel.receive({ id: message.id, result: { streamId: "active" } });
    };
    const data = vi.fn(),
      end = vi.fn(),
      error = vi.fn();
    const detach = await native.subscribe("lite", "subscribe_events", {}, {}, { data, end, error });
    detach();
    channel.receive({
      method: "rpc.stream.active",
      meta: { streamId: "active" },
      params: { data: { event: "done" } },
    });
    channel.receive({
      method: "rpc.stream.active",
      meta: { streamId: "active", done: true },
      params: {},
    });
    expect(data).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    native.close();
    expect(channel.sent.some((message) => message.method === "rpc.stream.cancel.active")).toBe(
      false,
    );
  });

  it("settles pending RPC and observers when closing without stopping the desktop", async () => {
    const { channel, native } = setup();
    channel.handle = (message) => {
      if (message.method === "request_stream")
        channel.receive({ id: message.id, result: { streamId: "active" } });
    };
    const error = vi.fn();
    await native.subscribe(
      "lite",
      "subscribe_events",
      {},
      {},
      { data: vi.fn(), end: vi.fn(), error },
    );
    const request = native.call("lite", "get_messages", {});
    const rejected = expect(request).rejects.toMatchObject({ code: "invalidState" });
    await vi.waitFor(() =>
      expect(channel.sent.some((message) => message.method === "request")).toBe(true),
    );
    native.close();
    await rejected;
    expect(error).toHaveBeenCalledOnce();
    expect(channel.sent.some((message) => message.method === "rpc.stream.cancel.active")).toBe(
      true,
    );
    expect(channel.listenerCount("message")).toBe(0);
    native.close();
  });

  it("rejects malformed native JSON instead of leaving a request pending", async () => {
    const { channel, native } = setup();
    channel.handle = () => channel.emit("message", "not-json");
    await expect(native.call("model", "model_list")).rejects.toMatchObject({
      code: "protocolError",
    });
    expect(channel.disconnected).toBe(true);
  });
});
