import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRelay, parseDesktopPairing, type RelaySocket } from "../src/desktop-relay.js";

const hash = Buffer.alloc(32, 8).toString("base64");
const link = `https://zcode.z.ai/remote/v4?sid=fixture-device&hash=${encodeURIComponent(hash)}&app_version=3.12.3`;
class Socket extends EventTarget implements RelaySocket {
  readyState = 1;
  send = vi.fn<(data: string) => void>();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
const relays: DesktopRelay[] = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
});
function fixture(timeout = 200) {
  const socket = new Socket(),
    factory = vi.fn(() => socket);
  const relay = new DesktopRelay(
    parseDesktopPairing(`${link}&mid=fixture-mid&relayOrigin=https://invalid.example`),
    timeout,
    factory,
  );
  relays.push(relay);
  const connecting = relay.connect();
  void connecting.catch(() => {});
  socket.dispatchEvent(new Event("open"));
  return { socket, factory, relay, connecting };
}
async function paired() {
  const f = fixture();
  f.socket.message({ type: "auth_challenge", nonce: "fixture-nonce" });
  f.socket.message({ type: "auth_ack", pair_status: "matched" });
  await f.connecting;
  return f;
}
describe("production Desktop Relay", () => {
  it("validates official URLs/version and never honors an injected Relay origin", async () => {
    for (const value of [
      link.replace("zcode.z.ai", "evil.example"),
      `${link}&sid=other`,
      link.replace("3.12.3", "9.9.9"),
      `${link}#secret`,
      link.replace("https:", "http:"),
      link.replace("/remote/v4", "/other"),
    ])
      expect(() => parseDesktopPairing(value)).toThrow();
    const f = await paired();
    expect(f.factory).toHaveBeenCalledExactlyOnceWith("wss://zcode.z.ai/ws?mid=fixture-mid");
    expect(JSON.stringify(f.relay)).not.toContain(hash);
  });
  it("waits for matching after proof, sends HMAC rather than the secret, and correlates replies", async () => {
    const f = fixture();
    f.socket.message({ type: "auth_challenge", nonce: "fixture-nonce" });
    f.socket.message({ type: "auth_ack", pair_status: "waiting" });
    await expect.poll(() => f.socket.send.mock.calls.length).toBe(2);
    expect(f.relay.signal.aborted).toBe(false);
    const sent = f.socket.send.mock.calls[1];
    if (!sent) throw new Error("Missing authentication proof");
    const proof = JSON.parse(sent[0]);
    expect(proof.proof).toBe(
      createHmac("sha256", hash)
        .update("fixture-nonce|terminal|fixture-device")
        .digest("base64url"),
    );
    expect(JSON.stringify(f.socket.send.mock.calls)).not.toContain(hash);
    f.socket.message({ type: "pair_status_ack", pair_status: "matched" });
    await f.connecting;
    const first = f.relay.request("first", "first-response"),
      second = f.relay.request("second", "second-response");
    const requests = f.socket.send.mock.calls.slice(-2).map(([data]) => JSON.parse(data).payload);
    f.socket.message({
      type: "data",
      payload: { requestId: requests[1].requestId, zcode_type: "second-response", value: 2 },
    });
    f.socket.message({
      type: "data",
      payload: { requestId: requests[0].requestId, zcode_type: "first-response", value: 1 },
    });
    expect(await first).toMatchObject({ value: 1 });
    expect(await second).toMatchObject({ value: 2 });
  });
  it("rejects out-of-order authentication and suppresses server diagnostics", async () => {
    const f = fixture();
    f.socket.message({ type: "auth_ack", pair_status: "matched", message: "private-server-data" });
    await expect(f.connecting).rejects.toThrow("invalid protocol");
    expect(f.socket.close).toHaveBeenCalledOnce();
    const g = fixture();
    g.socket.message({ type: "error", message: "private-server-data" });
    await expect(g.connecting).rejects.not.toThrow("private-server-data");
  });
  it("fails outstanding requests and never reconnects after another client takes over", async () => {
    const f = await paired(),
      pending = f.relay.request("first", "response");
    f.socket.message({ type: "error", code: "KICKED", message: hash });
    await expect(pending).rejects.not.toThrow(hash);
    expect(f.relay.signal.aborted).toBe(true);
    await expect(f.relay.connect()).rejects.toThrow("already started");
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it("bounds an unresponsive handshake and closes its socket", async () => {
    const f = fixture(10);
    await expect(f.connecting).rejects.toThrow("timed out");
    expect(f.socket.close).toHaveBeenCalledOnce();
  });
  it("fails closed on oversized frames and synchronous send failures without unhandled rejections", async () => {
    const f = await paired();
    f.socket.message({ type: "data", payload: "x".repeat(1024 * 1024) });
    await expect.poll(() => f.relay.signal.aborted).toBe(true);
    const g = await paired();
    g.socket.send.mockImplementationOnce(() => {
      throw new Error("private-send-error");
    });
    await expect(g.relay.request("request", "response")).rejects.not.toThrow("private-send-error");
    expect(g.socket.close).toHaveBeenCalledOnce();
  });
});
