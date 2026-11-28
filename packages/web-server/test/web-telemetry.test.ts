import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import {
  PRODUCT_TELEMETRY_SET_METHOD,
  PRODUCT_TELEMETRY_SIGNAL_METHOD,
  type ProductTelemetrySignalParams,
} from "@codexhost/shared-contracts";
import { serveChClientGateway } from "../src/ch-client-gateway.ts";
import { RequestTrust } from "../src/request-trust.ts";
import {
  WebProductTelemetry,
  classifyRemoteAccessChannel,
  classifyWebSurface,
} from "../src/web-telemetry.ts";

function fakeRequest(options: {
  remoteAddress?: string;
  localPort?: number;
  headers?: Record<string, string>;
  socket?: Socket;
}): IncomingMessage {
  const socket =
    options.socket ??
    ({
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
      localPort: options.localPort ?? 4400,
    } as unknown as Socket);
  return {
    socket,
    headers: options.headers ?? { host: "127.0.0.1:4400" },
  } as unknown as IncomingMessage;
}

test("classifyRemoteAccessChannel returns null for direct local loopback requests", () => {
  const trust = new RequestTrust(undefined);
  const req = fakeRequest({
    remoteAddress: "127.0.0.1",
    localPort: 4400,
    headers: { host: "127.0.0.1:4400" },
  });
  assert.equal(classifyRemoteAccessChannel(req, trust, "official"), null);
});

test("classifyRemoteAccessChannel distinguishes official-relay vs self-hosted-relay sockets", () => {
  const trust = new RequestTrust(undefined);
  const socket = { remoteAddress: "127.0.0.1", localPort: 4400 } as unknown as Socket;
  trust.relaySockets.set(socket, { address: "203.0.113.10", origin: "https://my.chost.dev" });
  const req = fakeRequest({ socket, headers: { host: "my.chost.dev" } });

  assert.equal(classifyRemoteAccessChannel(req, trust, "official"), "official-relay");
  assert.equal(classifyRemoteAccessChannel(req, trust, "self-hosted"), "self-hosted-relay");
});

test("classifyRemoteAccessChannel distinguishes tailscale-serve, tailscale-funnel, tailscale-ip, custom-proxy, and lan", () => {
  const tsTrust = new RequestTrust(undefined);
  tsTrust.trustLoopback = true;
  assert.equal(
    classifyRemoteAccessChannel(
      fakeRequest({
        remoteAddress: "127.0.0.1",
        headers: { host: "box.tail.ts.net", "x-forwarded-for": "100.88.1.2" },
      }),
      tsTrust,
      "official",
    ),
    "tailscale-serve",
  );
  assert.equal(
    classifyRemoteAccessChannel(
      fakeRequest({
        remoteAddress: "127.0.0.1",
        headers: { host: "box.tail.ts.net", "x-forwarded-for": "198.51.100.7" },
      }),
      tsTrust,
      "official",
    ),
    "tailscale-funnel",
  );

  const plainTrust = new RequestTrust(undefined);
  assert.equal(
    classifyRemoteAccessChannel(
      fakeRequest({ remoteAddress: "100.64.10.20", headers: { host: "100.64.10.1:4400" } }),
      plainTrust,
      "official",
    ),
    "tailscale-ip",
  );
  assert.equal(
    classifyRemoteAccessChannel(
      fakeRequest({ remoteAddress: "192.168.1.55", headers: { host: "192.168.1.10:4400" } }),
      plainTrust,
      "official",
    ),
    "lan",
  );

  const proxyTrust = new RequestTrust("127.0.0.1");
  assert.equal(
    classifyRemoteAccessChannel(
      fakeRequest({
        remoteAddress: "127.0.0.1",
        headers: { host: "code.example.com", "x-forwarded-for": "203.0.113.5" },
      }),
      proxyTrust,
      "official",
    ),
    "custom-proxy",
  );
});

test("classifyWebSurface distinguishes web, web-mobile, and web-desktop-shell user agents", () => {
  assert.equal(
    classifyWebSurface(fakeRequest({ headers: { "user-agent": "Mozilla/5.0 Chrome" } })),
    "web",
  );
  assert.equal(
    classifyWebSurface(fakeRequest({ headers: { "user-agent": "Mozilla/5.0 iPhone Safari" } })),
    "web-mobile",
  );
  assert.equal(
    classifyWebSurface(
      fakeRequest({ headers: { "user-agent": "CodexHostDesktop/0.29.0 Electron/34.0" } }),
    ),
    "web-desktop-shell",
  );
});

test("WebProductTelemetry batches active surfaces and remote access channels into one zero-ID signal", async () => {
  const sent: ProductTelemetrySignalParams[] = [];
  const telemetry = new WebProductTelemetry({
    send: async (signal) => {
      sent.push(signal);
    },
    debounceMs: 60_000,
  });

  const trust = new RequestTrust(undefined);
  const socket = { remoteAddress: "127.0.0.1", localPort: 4400 } as unknown as Socket;
  trust.relaySockets.set(socket, { address: "203.0.113.9", origin: "https://a.chost.dev" });
  const mobileRelayReq = fakeRequest({
    socket,
    headers: { host: "a.chost.dev", "user-agent": "Mozilla/5.0 Android Mobile" },
  });

  telemetry.observeAuthenticatedUpgrade(mobileRelayReq, trust, "official");
  telemetry.observeAuthenticatedUpgrade(mobileRelayReq, trust, "official");

  await telemetry.flushNow();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    surfaces: ["web-mobile"],
    remoteAccess: ["official-relay"],
  });
  telemetry.close();
});

test("serveChClientGateway blocks internal telemetry signal ingestion and unauthenticated telemetry writes", async () => {
  async function invokeGateway(
    method: string,
    params: Record<string, unknown>,
    authenticated: boolean,
  ) {
    const body = Buffer.from(JSON.stringify({ method, params }));
    const req = Object.assign(new EventEmitter(), {
      method: "POST",
      url: "/api/ch/v1/rpc",
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    }) as unknown as IncomingMessage;
    let status = 0;
    const res = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end() {
        this.writableEnded = true;
        return this;
      },
    } as unknown as ServerResponse;

    await serveChClientGateway(
      {
        realtime: {
          subscribe: () => () => undefined,
          request: async () => ({ ok: true }),
          snapshot: async () => {
            throw new Error("unused");
          },
          respond: async () => ({ resolved: true }),
        },
      },
      req,
      res,
      { authenticated },
    );
    return status;
  }

  assert.equal(await invokeGateway(PRODUCT_TELEMETRY_SIGNAL_METHOD, {}, true), 403);
  assert.equal(await invokeGateway(PRODUCT_TELEMETRY_SET_METHOD, { enabled: false }, false), 403);
  assert.equal(await invokeGateway(PRODUCT_TELEMETRY_SET_METHOD, { enabled: false }, true), 200);
});
