import { createSocket } from "node:dgram";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { BrowserContext } from "playwright-core";
import { RTCPeerConnection } from "werift";
import type { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import {
  decodeSidebarBrowserDirectFragment,
  decodeSidebarBrowserFrameHeader,
  encodeSidebarBrowserDirectAck,
  SIDEBAR_BROWSER_DIRECT_CONTROL,
  SIDEBAR_BROWSER_DIRECT_PING,
  sidebarBrowserFramesChannel,
  type SidebarBrowserDirectClientMessage,
  type SidebarBrowserDirectServerMessage,
  type SidebarBrowserServerMessage,
} from "@codexhost/shared-contracts/sidebar-browser";
import { CredentialConnections } from "../../packages/web-server/src/auth.ts";
import { RequestTrust } from "../../packages/web-server/src/request-trust.ts";
import {
  SidebarBrowserDirect,
  sidebarDirectStunUrls,
} from "../../packages/web-server/src/sidebar-browser-direct.ts";
import {
  DEFAULT_SIDEBAR_BROWSER_QUALITY,
  SidebarBrowserTab,
} from "../../packages/web-server/src/sidebar-browser-tab.ts";
import { DataDir } from "../../packages/web-server/src/store.ts";

const cleanups: (() => void | Promise<unknown>)[] = [];
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

function direct(iceServers = ["stun:127.0.0.1:9"]) {
  const folder = mkdtempSync(join(tmpdir(), "codexhost-direct-test-"));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const connections = new CredentialConnections();
  const peers = new SidebarBrowserDirect(new DataDir(folder), connections, iceServers);
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
    iceServers: [],
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
  const offer = async (id: number, restart = false): Promise<void> => {
    attempt = id;
    sent = false;
    cached = [];
    const description = await pc.createOffer({ iceRestart: restart });
    const applying = pc.setLocalDescription(description);
    send({ type: "direct-offer", attempt, sdp: description.sdp, restart });
    sent = true;
    for (const message of cached) send(message);
    await applying;
  };
  return { pc, control, offer };
}

it("trickles before an unresponsive STUN deadline, isolates the retired peer, and revokes writes", async () => {
  const sink = createSocket("udp4");
  cleanups.push(() => sink.close());
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
    { timeout: 11_000 },
  );
  const answer = trace.find((signal) => signal.type === "direct-answer" && signal.attempt === 2)!;
  expect(answer.at - started).toBeLessThan(1_000);
  expect(trace.some((signal) => signal.type === "direct-close" && signal.attempt === 2)).toBe(
    false,
  );
  expect(peers.session(hello.peer, "other")).toBeUndefined();
  const before = trace.length;
  connections.revoke("owner");
  expect(socket.readyState).toBe(3);
  expect(peers.session(hello.peer, "owner")).toBeUndefined();
  await second.control.stateChanged.watch((state) => state === "closed", 3000);
  socket.receive({ type: "direct-offer", attempt: 3, restart: false, sdp: "not an offer" });
  expect(trace).toHaveLength(before);
  expect(JSON.stringify(logs.mock.calls)).not.toContain("127.0.0.1");
}, 15_000);

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
  ).toEqual([false, false, false, false, false, false, true, true, true, true]);
  expect(direct(sidebarDirectStunUrls("")).hello.offered).toBe(false);
  expect(() => sidebarDirectStunUrls("stun:test.invalid,turn:test.invalid")).toThrow(
    /only accepts stun:/,
  );
});

async function tab() {
  const cdp = Object.assign(new EventEmitter(), {
    send: async (name: string) =>
      name === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : name === "Page.captureScreenshot"
          ? { data: "" }
          : undefined,
  });
  const page = Object.assign(new EventEmitter(), {
    close: async () => undefined,
    context: () => context,
    frames: () => [],
    exposeBinding: async () => undefined,
    goto: async () => undefined,
    url: () => "https://example.test/",
    title: async () => "example",
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
    async paint(id: number) {
      cdp.emit("Page.screencastFrame", {
        sessionId: 1,
        data: Buffer.alloc(330 * 1024, id).toString("base64"),
      });
      await setImmediate();
    },
  };
}

it("shares the cumulative frame window across routes and immediately resends on channel close", async () => {
  const { peers, socket, hello, trace } = direct();
  const { pc, control, offer } = client(socket);
  await offer(1);
  await vi.waitFor(() => expect(trace.at(-1)?.type).toBe("direct-ready"), { timeout: 8_000 });
  const viewer = await tab();
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
  const old = decodeSidebarBrowserFrameHeader(Uint8Array.from(viewer.pictures[0]!).buffer).sequence;
  viewer.label.receive({ type: "transport", peer: hello.peer });
  await viewer.paint(73);
  const lastPart = () =>
    fragments.find((fragment) => fragment.offset + fragment.payload.length === fragment.total);
  await vi.waitFor(() => expect(lastPart()).toBeDefined());
  expect(fragments[0]?.attempt).toBe(1);
  expect(fragments[0]?.sequence).toBeGreaterThan(old);
  expect(fragments[0]?.payload[17]).toBe(73);
  expect(viewer.messages).toContainEqual({
    type: "transport",
    via: "direct",
    from: fragments[0]?.sequence,
  });
  channel.send(encodeSidebarBrowserDirectAck(lastPart()!.sequence));
  await viewer.paint(74);
  await vi.waitFor(() =>
    expect(fragments.find((fragment) => fragment.sequence > lastPart()!.sequence)).toBeDefined(),
  );
  channel.close();
  await vi.waitFor(() => expect(viewer.pictures.length).toBe(2), { timeout: 1500 });
  expect(viewer.messages).toContainEqual({ type: "transport", via: "socket" });
  expect(viewer.pictures.at(-1)?.[17]).toBe(74);
}, 12_000);
