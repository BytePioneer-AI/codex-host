import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import type { BrowserContext } from "playwright-core";
import { RTCPeerConnection } from "werift";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import {
  decodeSidebarBrowserDirectFragment,
  decodeSidebarBrowserFrameHeader,
  encodeSidebarBrowserDirectAck,
  SIDEBAR_BROWSER_DIRECT_CONTROL,
  SIDEBAR_BROWSER_DIRECT_PING,
  SIDEBAR_BROWSER_PATH,
  sidebarBrowserFramesChannel,
  type SidebarBrowserDirectClientMessage,
  type SidebarBrowserDirectServerMessage,
  type SidebarBrowserServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import { AccessTokenStore } from "../../packages/web-server/src/access-tokens.ts";
import { AccessAuth, CredentialConnections } from "../../packages/web-server/src/auth.ts";
import { RequestTrust } from "../../packages/web-server/src/request-trust.ts";
import {
  SidebarBrowserDirect,
  sidebarDirectStunUrls,
} from "../../packages/web-server/src/sidebar-browser-direct.ts";
import {
  DEFAULT_SIDEBAR_BROWSER_QUALITY,
  SidebarBrowserTab,
} from "../../packages/web-server/src/sidebar-browser-tab.ts";
import { SidebarBrowser } from "../../packages/web-server/src/sidebar-browser.ts";
import { DataDir } from "../../packages/web-server/src/store.ts";

const cleanups: Array<(() => void) | (() => Promise<unknown>)> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  bufferedAmount = 0;
  send(data: string | Buffer): void {
    this.emit("sent", data);
  }
  receive(message: unknown): void {
    this.emit("message", JSON.stringify(message), false);
  }
  terminate(): void {
    if (this.readyState === this.OPEN) {
      this.readyState = 3;
      this.emit("close");
    }
  }
  close(): void {
    this.terminate();
  }
  get ws(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function tempData() {
  const folder = mkdtempSync(join(tmpdir(), "codexhost-direct-test-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  return new DataDir(folder);
}

function direct(iceServers: readonly string[] = ["stun:127.0.0.1:9"]) {
  const connections = new CredentialConnections();
  const peers = new SidebarBrowserDirect(tempData(), connections, iceServers);
  cleanups.push(() => peers.close());
  const socket = new TestSocket();
  const trace: (SidebarBrowserDirectServerMessage & { at: number })[] = [];
  socket.on("sent", (data: string) => trace.push({ ...JSON.parse(data), at: performance.now() }));
  peers.attach(socket.ws, "owner", true);
  const hello = trace[0];
  if (hello?.type !== "direct-hello") throw new Error("missing direct-hello");
  return { peers, socket, trace, hello, connections };
}

function client(socket: TestSocket) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:127.0.0.1:9" }],
    iceStunGatherTimeout: 0.05,
    iceUseIpv6: false,
    iceAdditionalHostAddresses: ["127.0.0.1"],
  });
  cleanups.push(() => pc.close());
  const control = pc.createDataChannel(SIDEBAR_BROWSER_DIRECT_CONTROL);
  let attempt = 0;
  let sent = false;
  let cached: SidebarBrowserDirectClientMessage[] = [];
  let incoming = Promise.resolve();
  const send = (message: SidebarBrowserDirectClientMessage) => socket.receive(message);
  pc.onIceCandidate.subscribe((candidate) => {
    const data = candidate?.toJSON();
    const message = { type: "direct-candidate", attempt, candidate: data ?? null } as const;
    if (sent) socket.receive(message);
    else cached.push(message as SidebarBrowserDirectClientMessage);
  });
  const listener = (data: string): void => {
    const signal = JSON.parse(data) as SidebarBrowserDirectServerMessage;
    if (!("attempt" in signal) || signal.attempt !== attempt) return;
    incoming = incoming.then(async () => {
      if (signal.type === "direct-answer")
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      if (signal.type === "direct-candidate" && signal.candidate)
        await pc.addIceCandidate(signal.candidate);
    });
    void incoming.catch(() => undefined);
  };
  socket.on("sent", listener);
  cleanups.push(() => {
    socket.off("sent", listener);
  });
  const offer = async (id: number, restart = false, fingerprintMismatch = false): Promise<void> => {
    attempt = id;
    sent = false;
    cached = [];
    const description = await pc.createOffer({ iceRestart: restart });
    const applying = pc.setLocalDescription(description);
    const sdp = fingerprintMismatch
      ? description.sdp.replace(
          /(a=fingerprint:sha-256 )[^\r\n]+/u,
          `$1${Array(32).fill("00").join(":")}`,
        )
      : description.sdp;
    send({ type: "direct-offer", attempt, sdp, restart });
    sent = true;
    for (const message of cached) send(message);
    await applying;
  };
  return { pc, control, offer };
}

it("trickles before an unresponsive STUN deadline, isolates the retired peer, and revokes writes", async () => {
  const sink = createSocket("udp4");
  cleanups.push(() => {
    sink.close();
  });
  sink.bind(0, "127.0.0.1");
  await once(sink, "listening");
  const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const { socket, trace, connections, peers, hello } = direct([
    `stun:127.0.0.1:${sink.address().port}`,
  ]);
  const first = client(socket);
  const request = once(sink, "message");
  await first.offer(1);
  await request;
  expect(trace.some(({ type }) => type === "direct-answer")).toBe(true);
  expect(
    trace.some((message) => message.type === "direct-candidate" && message.candidate === null),
  ).toBe(false);
  const second = client(socket);
  const started = performance.now();
  await second.offer(2);
  void first.pc.close();
  await vi.waitFor(
    () =>
      expect(
        trace.find((signal) => signal.type === "direct-ready" && signal.attempt === 2),
      ).toBeDefined(),
    { timeout: 3_000 },
  );
  const answer = trace.find((signal) => signal.type === "direct-answer" && signal.attempt === 2);
  assert.ok(answer, "Expected direct-answer for attempt 2");
  expect(answer.at - started).toBeLessThan(1_000);
  // Stronger than a checking-state assertion: DTLS and SCTP also complete before 3 seconds.
  const ready = trace.find((signal) => signal.type === "direct-ready" && signal.attempt === 2);
  assert.ok(ready, "Expected direct-ready for attempt 2");
  expect(ready.at - started).toBeLessThan(3_000);
  expect(trace.some((signal) => signal.type === "direct-close" && signal.attempt === 2)).toBe(
    false,
  );
  expect(peers.session(hello.peer, "other")).toBeUndefined();
  const next = (type: string, attempt: number) =>
    trace.some(
      (signal) => signal.type === type && "attempt" in signal && signal.attempt === attempt,
    );
  second.control.close();
  await vi.waitFor(() => expect(next("direct-close", 2)).toBe(true));
  const replacement = second.pc.createDataChannel(SIDEBAR_BROWSER_DIRECT_CONTROL);
  // Wait until the server has accepted the channel, without sending a restart offer yet.
  await replacement.stateChanged.watch((state) => state === "open", 1_000);
  await second.offer(3, true);
  await vi.waitFor(() => expect(next("direct-ready", 3)).toBe(true), { timeout: 3_000 });
  const before = trace.length;
  connections.revoke("owner");
  expect(socket.readyState).toBe(3);
  expect(peers.session(hello.peer, "owner")).toBeUndefined();
  await replacement.stateChanged.watch((state) => state === "closed", 3000);
  socket.receive({ type: "direct-offer", attempt: 4, restart: false, sdp: "not an offer" });
  expect(trace).toHaveLength(before);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("127.0.0.1");
}, 15_000);

it("classifies client-ended attempts and logs only aggregated ICE candidate metadata", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const { socket } = direct();
  const { offer } = client(socket);
  const addresses = ["192.0.2.10", "2001:db8::10", "198.51.100.10"];
  const reasonCases = [
    ["ready-timeout", "failed", "ready-timeout"],
    ["connection-lost", "failed", "connection-lost"],
    ["background", "closed", "background"],
    ["network-changed", "closed", "network-changed"],
    ["signaling-closed", "closed", "signaling-closed"],
    ["private-details", "failed", "unclassified"],
  ] as const;
  for (const [index, [reason, outcome, loggedReason]] of reasonCases.entries()) {
    const attempt = index + 1;
    await offer(attempt);
    if (index === 0) {
      const lines = [
        `candidate:1 1 UDP 2130706431 ${addresses[0]} 50001 typ host`,
        `candidate:2 1 UDP 1694498815 ${addresses[1]} 50002 typ srflx raddr ${addresses[0]} rport 50001`,
        `candidate:3 1 UDP 1862270975 ${addresses[2]} 50003 typ prflx`,
      ];
      for (const candidate of [...lines, lines[1]])
        socket.receive({
          type: "direct-candidate",
          attempt,
          candidate: { candidate, sdpMid: "0" },
        });
    }
    socket.receive({ type: "direct-close", attempt, reason });
    const call = logs.mock.calls.filter(([tag]) => tag === "[direct] attempt").at(-1);
    assert.ok(call, `Expected a log for attempt ${attempt}`);
    const log = JSON.parse(call[1]);
    expect(log).toMatchObject({ attempt, outcome, reason: loggedReason });
    expect(log.candidates.remoteSrflxReceived).toBe(index === 0);
    if (index === 0) {
      expect(log.candidates.remote.ipv4.host).toBeGreaterThan(0);
      expect(log.candidates.remote.ipv4.prflx).toBe(1);
      expect(log.candidates.remote.ipv6).toEqual({ host: 0, srflx: 1, prflx: 0 });
    }
  }
  const output = JSON.stringify(logs.mock.calls);
  for (const address of addresses) expect(output).not.toContain(address);
  expect(output).not.toContain("private-details");
});

it("does not accept DTLS when the caller's certificate disagrees with its offer fingerprint", async () => {
  const { socket, trace } = direct();
  const { pc, control, offer } = client(socket);
  await offer(1, false, true);
  await vi.waitFor(() => expect(pc.connectionState).toBe("failed"), { timeout: 3_500 });
  expect(trace.some(({ type }) => type === "direct-ready")).toBe(false);
  expect(control.readyState).not.toBe("open");
});

it("closes a real sidebar label upgrade when its access token is rotated", async () => {
  const data = tempData();
  const tokens = new AccessTokenStore(data);
  cleanups.push(() => tokens.close());
  const connections = new CredentialConnections();
  tokens.onRevoked((id) => connections.revoke(id));
  const trust = new RequestTrust(undefined);
  const auth = new AccessAuth(tokens, trust, connections);
  const sidebar = new SidebarBrowser({
    profileDirectory: data.path("browser"),
    direct: new SidebarBrowserDirect(data, connections, []),
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) =>
    sidebar.upgrade(request, socket, head, trust, auth),
  );
  server.listen(0, "127.0.0.1");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => sidebar.close(),
  );
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const label = new WebSocket(
    `ws://127.0.0.1:${port}${SIDEBAR_BROWSER_PATH}?ignored=what?ever&tab=example`,
    {
      headers: { authorization: `Bearer ${tokens.current().secret}` },
    },
  );
  cleanups.push(() => label.terminate());
  const [initial] = await once(label, "message", { signal: AbortSignal.timeout(2_000) });
  expect(JSON.parse(String(initial)).type).toBe("state");
  const closed = once(label, "close", { signal: AbortSignal.timeout(2_000) });
  tokens.regenerate();
  await closed;
  expect(label.readyState).toBe(WebSocket.CLOSED);
});

it("classifies the admitted upgrade using D13, without waiting for Serve polling", () => {
  const trust = new RequestTrust("192.168.1.6");
  const request = (remoteAddress: string, headers: object = {}) =>
    ({
      headers: { host: "proxy.test", ...headers },
      socket: { remoteAddress, localPort: 3000 },
    }) as IncomingMessage;
  const relay = request("127.0.0.1");
  trust.relaySockets.set(relay.socket as Socket, {
    address: "198.51.100.7",
    origin: "https://relay.test",
  });
  expect(
    [
      request("127.0.0.1", { host: "localhost:3000" }),
      request("::1", { host: "[::1]:3000" }),
      request("::1", { host: "[::1]:3001" }),
      request("192.168.1.4"),
      request("100.64.0.50"),
      request("2001:db8::3"),
      request("127.0.0.1", { "x-forwarded-for": "198.51.100.4, 100.64.0.5" }),
      request("::1", { "x-forwarded-for": "fd7a:115c:a1e0::4" }),
      request("::1", { "x-forwarded-for": "100.64.0.5, 198.51.100.4" }),
      relay,
      request("192.168.1.6"),
      request("127.0.0.1"),
    ].map((upgrade) => trust.offersSidebarDirect(upgrade)),
  ).toEqual([false, false, true, false, false, false, false, false, true, true, true, true]);
  expect(direct(sidebarDirectStunUrls("")).hello.offered).toBe(false);
  expect(() => sidebarDirectStunUrls("stun:test.invalid,turn:test.invalid")).toThrow(
    /only accepts stun:/,
  );
});

function tab() {
  let castWidth = 0;
  let stopCast: Promise<void> | undefined;
  const cdp = Object.assign(new EventEmitter(), {
    send: async (name: string, args?: { maxWidth: number }) => {
      if (name === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (name === "Page.captureScreenshot" && castWidth > 1000) return { data: "" };
      if (name === "Page.startScreencast") {
        assert.ok(args, "Expected screencast options");
        castWidth = args.maxWidth;
      }
      if (name === "Page.stopScreencast") await stopCast;
      return undefined;
    },
  });
  const page = Object.assign(new EventEmitter(), {
    close: async () => undefined,
    context: () => context,
    frames: () => [],
    exposeBinding: async () => undefined,
    goto: async () => undefined,
    url: () => "https://example.test/",
    title: async () => "example",
    mouse: { move: async () => undefined, wheel: async () => undefined },
  });
  const context = { newCDPSession: async () => cdp, newPage: async () => page };
  const tab = new SidebarBrowserTab(
    "test",
    async () => context as unknown as BrowserContext,
    DEFAULT_SIDEBAR_BROWSER_QUALITY,
  );
  cleanups.push(() => tab.close());
  const label = new TestSocket();
  const pictures: Buffer[] = [];
  const messages: SidebarBrowserServerMessage[] = [];
  label.on("sent", (data: string | Buffer) => {
    if (Buffer.isBuffer(data)) pictures.push(data);
    else messages.push(JSON.parse(data));
  });
  return {
    tab,
    label,
    pictures,
    messages,
    get castWidth() {
      return castWidth;
    },
    blockStop() {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      stopCast = promise;
      const unblock = () => resolve(undefined);
      cleanups.push(unblock);
      return unblock;
    },
    async paint(id: number) {
      cdp.emit("Page.screencastFrame", {
        sessionId: 1,
        data: Buffer.alloc(330 * 1024, id).toString("base64"),
      });
      await setImmediate();
    },
  };
}

it("isolates stale bindings and immediately resends the cached 1x frame before adjusting quality", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const { peers, socket, hello, trace } = direct();
  const { pc, control, offer } = client(socket);
  await offer(1);
  await vi.waitFor(() => expect(trace.at(-1)?.type).toBe("direct-ready"), { timeout: 8_000 });
  const viewer = tab();
  const channel = pc.createDataChannel(sidebarBrowserFramesChannel("test"));
  const fragments: NonNullable<ReturnType<typeof decodeSidebarBrowserDirectFragment>>[] = [];
  channel.onMessage.subscribe((data) => {
    if (typeof data !== "string") {
      expect(data.length).toBeLessThanOrEqual(16 * 1024);
      const part = decodeSidebarBrowserDirectFragment(data);
      expect(part).toBeDefined();
      if (part) fragments.push(part);
    }
  });
  const ping = setInterval(() => control.send(SIDEBAR_BROWSER_DIRECT_PING), 500);
  cleanups.push(() => clearInterval(ping));
  await channel.stateChanged.watch((state) => state === "open", 3000);
  viewer.tab.attach(viewer.label.ws, (peer) => peers.session(peer, "owner"));
  viewer.label.receive({ type: "visible", visible: true });
  viewer.label.receive({ type: "navigate", url: "https://example.test/" });
  await vi.waitFor(() => expect(viewer.pictures.length).toBe(1));
  const firstPicture = viewer.pictures[0];
  assert.ok(firstPicture, "Expected the initial picture");
  const old = decodeSidebarBrowserFrameHeader(Uint8Array.from(firstPicture).buffer).sequence;
  viewer.label.receive({ type: "transport", peer: "not-this-viewer", binding: 1 });
  expect(viewer.messages).toContainEqual({ type: "transport", binding: 1, via: "socket" });
  viewer.label.receive({ type: "transport", peer: hello.peer, binding: 2 });
  viewer.label.receive({ type: "transport", binding: 1 });
  viewer.label.receive({ type: "transport", peer: "not-this-viewer", binding: 1 });
  await viewer.paint(73);
  const lastPart = () =>
    fragments.find((fragment) => fragment.offset + fragment.payload.length === fragment.total);
  await vi.waitFor(() => expect(lastPart()).toBeDefined());
  expect(fragments[0]?.attempt).toBe(1);
  expect(fragments[0]?.sequence).toBeGreaterThan(old);
  expect(fragments[0]?.payload[17]).toBe(73);
  expect(viewer.messages).toContainEqual({
    type: "transport",
    binding: 2,
    via: "direct",
    from: fragments[0]?.sequence,
  });
  const last = lastPart();
  assert.ok(last, "Expected the last fragment of the first direct picture");
  channel.send(encodeSidebarBrowserDirectAck(last.sequence));
  await viewer.paint(74);
  await vi.waitFor(() =>
    expect(fragments.find((fragment) => fragment.sequence > last.sequence)).toBeDefined(),
  );
  await delay(225); // A slow in-flight frame affects quality once input resumes.
  viewer.label.receive({ type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 1 });
  await vi.waitFor(() => expect(viewer.castWidth).toBe(1000));
  await viewer.paint(75);
  const unblock = viewer.blockStop();
  channel.close();
  await vi.waitFor(() => expect(viewer.pictures.length).toBe(2), { timeout: 1500 });
  expect(viewer.messages).toContainEqual({ type: "transport", binding: 2, via: "socket" });
  expect(viewer.pictures.at(-1)?.[17]).toBe(75);
  unblock();
  await vi.waitFor(() => expect(viewer.castWidth).toBe(2000));
  peers.close();
  const session = logs.mock.calls.find(([tag]) => tag === "[direct] session");
  assert.ok(session, "Expected a direct session log");
  const [, payload] = session;
  expect(JSON.parse(payload)).toMatchObject({
    directBytes: fragments.reduce((bytes, part) => bytes + part.payload.length, 0),
    socketBytes: viewer.pictures.slice(1).reduce((bytes, picture) => bytes + picture.length, 0),
  });
}, 12_000);
