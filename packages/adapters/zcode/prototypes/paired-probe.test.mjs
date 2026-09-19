import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairedRelay, parsePairingUrl } from "./paired-relay.mjs";
import { probePairedCatalog } from "./paired-catalog.mjs";

const hash = Buffer.alloc(32, 7).toString("base64");
const pairingUrl = `https://zcode.z.ai/remote/v4?sid=test-device&hash=${encodeURIComponent(hash)}&app_version=3.12.3`;
const relays = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
  vi.useRealTimers();
});

class Socket extends EventTarget {
  readyState = 0;
  sent = [];
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(value) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
function transport(timeoutMs = 1000, url = pairingUrl) {
  const socket = new Socket();
  const factory = vi.fn(() => socket);
  const relay = new PairedRelay(parsePairingUrl(url), { socketFactory: factory, timeoutMs });
  relays.push(relay);
  return { socket, factory, relay };
}
async function pair() {
  const f = transport();
  const connected = f.relay.connect();
  f.socket.open();
  f.socket.receive({ type: "auth_challenge", nonce: "test-nonce" });
  f.socket.receive({ type: "auth_ack", pair_status: "matched" });
  await connected;
  return f;
}

describe("experimental paired Relay", () => {
  it("accepts only explicit native production pairing URLs of the verified version", () => {
    expect(parsePairingUrl(pairingUrl)).toEqual({ deviceSid: "test-device", passHash: hash });
    for (const url of [
      pairingUrl.replace("https:", "http:"),
      pairingUrl.replace("zcode.z.ai", "evil.example"),
      pairingUrl.replace("/remote/v4", "/remote/v3"),
      pairingUrl.replace("https://", "https://user:secret@"),
      `${pairingUrl}&hash=${hash}`,
      pairingUrl.replace("3.12.3", "3.12.4"),
      `${pairingUrl}#secret`,
      "x".repeat(8193),
    ])
      expect(() => parsePairingUrl(url)).toThrow(/invalid-pairing-url|unsupported-desktop-version/);
  });
  it("preserves optional native device identity but never accepts an injected Relay destination", async () => {
    const f = transport(1000, `${pairingUrl}&mid=test-mid&relayOrigin=https://evil.example`);
    const connected = f.relay.connect();
    f.socket.open();
    f.socket.receive({ type: "auth_challenge", nonce: "test-nonce" });
    f.socket.receive({ type: "auth_ack", pair_status: "matched" });
    await connected;
    expect(f.factory).toHaveBeenCalledExactlyOnceWith("wss://zcode.z.ai/ws?mid=test-mid");
  });
  it("uses the terminal challenge-response, not the plaintext pairing hash", async () => {
    const f = await pair();
    expect(f.factory).toHaveBeenCalledExactlyOnceWith("wss://zcode.z.ai/ws");
    expect(f.socket.sent[0]).toMatchObject({
      type: "auth_init",
      role: "terminal",
      device_sid: "test-device",
    });
    expect(f.socket.sent[1]).toMatchObject({
      type: "auth_response",
      device_sid: "test-device",
      proof: createHmac("sha256", hash)
        .update("test-nonce|terminal|test-device")
        .digest("base64url"),
    });
    expect(JSON.stringify(f.socket.sent)).not.toContain(hash);
    expect(JSON.stringify(f.relay)).not.toContain(hash);
  });
  it("correlates workspace requests and forwards RPC frames without logging them", async () => {
    const f = await pair();
    const listener = vi.fn();
    f.relay.onPayload(listener);
    const result = f.relay.request("workspace-list-request", "workspace-list-response");
    const outgoing = f.socket.sent.at(-1);
    expect(outgoing.type).toBe("data");
    f.socket.receive({
      type: "data",
      payload: {
        zcode_type: "workspace-list-response",
        requestId: outgoing.payload.requestId,
        success: true,
        result: { workspaces: [] },
      },
    });
    await expect(result).resolves.toMatchObject({ success: true });
    f.socket.receive({ type: "data", payload: { zcode_type: "rpc-frame", seq: 1 } });
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({ zcode_type: "rpc-frame", seq: 1 }),
    );
  });
  it("rejects success before the challenge and suppresses server error messages", async () => {
    const f = transport();
    const result = f.relay.connect();
    f.socket.open();
    f.socket.receive({ type: "auth_ack", pair_status: "matched" });
    await expect(result).rejects.toThrow("invalid-relay-message");
    const other = transport();
    const rejected = other.relay.connect();
    other.socket.open();
    other.socket.receive({ type: "error", code: "AUTH_FAILED", message: pairingUrl });
    await expect(rejected).rejects.toThrow("pairing-rejected");
  });
  it("does not reconnect or fight another terminal after KICKED", async () => {
    const f = await pair();
    const pending = f.relay.request("workspace-list-request", "workspace-list-response");
    f.socket.receive({ type: "error", code: "KICKED", message: hash });
    await expect(pending).rejects.toThrow(/connection-closed|session-conflict/);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.relay.signal.aborted).toBe(true);
    expect(JSON.stringify(f.relay)).not.toContain(hash);
  });
  it("bounds handshake duration and disposes the socket", async () => {
    vi.useFakeTimers();
    const f = transport(20);
    const result = expect(f.relay.connect()).rejects.toThrow("pairing-timeout");
    await vi.advanceTimersByTimeAsync(21);
    await result;
    expect(f.socket.readyState).toBe(3);
  });
  it("fails closed for oversized messages", async () => {
    const f = await pair();
    f.socket.receive({ type: "data", payload: "x".repeat(1024 * 1024) });
    await vi.waitFor(() => expect(f.relay.signal.aborted).toBe(true));
  });
});

function desktop() {
  const cwd = "/fixture/workspace";
  const close = vi.fn();
  const native = vi.fn(async (method, [params]) => {
    if (method === "closeSession") return true;
    if (method !== "createSession") throw new Error("Forbidden native method");
    if (params.sessionId !== undefined)
      throw new Error("sessionId is only supported for imported history creates");
    return {
      session: { sessionId: "sess_generated_fixture", workspace: { workspacePath: cwd } },
      messages: [],
      projection: {},
      settings: {
        model: {
          available: [
            {
              ref: { providerId: "fixture-account", modelId: "fixture-model" },
              label: "Fixture",
              apiKey: "secret-extra-field",
              reasoning: { levels: [{ value: "high", label: "High" }] },
            },
            {
              ref: { providerId: "disabled", modelId: "disabled" },
              label: "Disabled",
              disabledReason: "not-entitled",
            },
          ],
        },
      },
    };
  });
  const channel = vi.fn(() => ({ call: native }));
  const rpcDispose = vi.fn(),
    protocolDispose = vi.fn(),
    removeListener = vi.fn();
  const createProtocol = vi.fn(() => ({
    protocol: {},
    acceptPayload: vi.fn(),
    dispose: protocolDispose,
    onDegraded: () => ({ dispose: vi.fn() }),
  }));
  const relay = {
    signal: new AbortController().signal,
    close,
    sendPayload: vi.fn(),
    onPayload: vi.fn(() => removeListener),
    request: vi.fn(async (type, response, params) =>
      type === "workspace-list-request"
        ? { success: true, result: { workspaces: [{ kind: "local", workspacePath: cwd }] } }
        : { ...params, bridge: { ...params, kind: "local", workspacePath: cwd } },
    ),
  };
  const options = {
    cwd,
    createProtocol,
    createRpc: () => ({ getChannel: channel, dispose: rpcDispose }),
    timeoutMs: 50,
  };
  return { relay, options, native, channel, rpcDispose, protocolDispose, removeListener };
}

describe("paired directory probe ownership and data minimization", () => {
  it("reads ONLY its own deferred snapshot, projects safe fields, and closes before success", async () => {
    const f = desktop();
    const result = await probePairedCatalog(f.relay, f.options);
    expect(f.native.mock.calls.map(([method]) => method)).toEqual([
      "createSession",
      "closeSession",
    ]);
    expect(f.channel.mock.calls.flat()).toEqual(["zcode-agent", "zcode-agent"]);
    const created = f.native.mock.calls[0][1][0];
    expect(created).toMatchObject({
      persistence: "deferred",
      titleGenerationEnabled: false,
      mcpServers: [],
    });
    expect(created).not.toHaveProperty("model");
    expect(created).not.toHaveProperty("sessionId");
    expect(created).not.toHaveProperty("importedHistory");
    expect(f.native.mock.calls[1][1][0]).toEqual({
      workspacePath: f.options.cwd,
      sessionId: "sess_generated_fixture",
      expectedPersistence: "deferred",
    });
    expect(result.cleanupConfirmed).toBe(true);
    expect(result.models).toEqual([
      {
        providerId: "fixture-account",
        modelId: "fixture-model",
        label: "Fixture",
        thinking: [{ value: "high", label: "High" }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-extra-field");
    expect(f.rpcDispose).toHaveBeenCalledTimes(1);
    expect(f.protocolDispose).toHaveBeenCalledTimes(1);
    expect(f.removeListener).toHaveBeenCalledTimes(1);
    expect(f.relay.close).toHaveBeenCalledTimes(1);
  });
  it("does not guess another workspace or touch existing user Sessions", async () => {
    const f = desktop();
    f.options.cwd = "/other";
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow(
      "workspace-not-open-or-ambiguous",
    );
    expect(f.native).not.toHaveBeenCalled();
    expect(f.relay.close).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched bridge before creating anything", async () => {
    const f = desktop();
    f.relay.request
      .mockResolvedValueOnce({
        success: true,
        result: { workspaces: [{ kind: "local", workspacePath: f.options.cwd }] },
      })
      .mockResolvedValueOnce({ bridgeSessionId: "wrong" });
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow(
      "unexpected-workspace-bridge",
    );
    expect(f.native).not.toHaveBeenCalled();
  });
  it("does not close an unverified identity from a malformed create snapshot", async () => {
    const f = desktop();
    f.native.mockResolvedValueOnce({ session: { sessionId: "user-session" } });
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow(
      "deferred-session-cleanup-unconfirmed",
    );
    expect(f.native.mock.calls.map(([method]) => method)).toEqual(["createSession"]);
  });
  it("closes its confirmed empty Session even when the model catalog is malformed", async () => {
    const f = desktop();
    f.native.mockResolvedValueOnce({
      session: { sessionId: "sess_created", workspace: { workspacePath: f.options.cwd } },
      messages: [],
      projection: {},
      settings: {},
    });
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow("invalid-model-catalog");
    expect(f.native.mock.calls[1][1][0]).toMatchObject({
      sessionId: "sess_created",
      expectedPersistence: "deferred",
    });
  });
  it("preserves a genuinely empty native catalog instead of inventing official Models", async () => {
    const f = desktop();
    f.native.mockResolvedValueOnce({
      session: { sessionId: "sess_created", workspace: { workspacePath: f.options.cwd } },
      messages: [],
      projection: {},
      settings: { model: { available: [] } },
    });
    await expect(probePairedCatalog(f.relay, f.options)).resolves.toEqual({
      models: [],
      cleanupConfirmed: true,
    });
  });
  it("never reports success if deferred cleanup is not confirmed", async () => {
    const f = desktop();
    const original = f.native.getMockImplementation();
    f.native.mockImplementation((method, args) =>
      method === "closeSession" ? false : original(method, args),
    );
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow(
      "deferred-session-cleanup-unconfirmed",
    );
    expect(f.relay.close).toHaveBeenCalledTimes(1);
  });
  it("reports lost create receipts without retrying or guessing another Session to close", async () => {
    const f = desktop();
    f.options.timeoutMs = 5;
    f.native.mockImplementation(async (method) =>
      method === "createSession" ? new Promise(() => {}) : true,
    );
    await expect(probePairedCatalog(f.relay, f.options)).rejects.toThrow(
      "deferred-session-cleanup-unconfirmed",
    );
    expect(f.native.mock.calls.map(([method]) => method)).toEqual(["createSession"]);
  });
});
