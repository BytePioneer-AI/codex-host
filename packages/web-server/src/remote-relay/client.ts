import { sign } from "node:crypto";
import { request, type ClientRequest } from "node:http";
import {
  constants,
  createServer,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { connect } from "node:tls";
import { createWebSocketStream, WebSocket } from "ws";
import {
  closeCodes,
  connectionWindowSize,
  headers,
  maxPayload,
  normalizeControlHost,
  paths,
  registrationContent,
  streamWindowSize,
} from "@codexhost/remote-relay/protocol";
import type { WebRelayState } from "@codexhost/shared-contracts";
import type { relayIdentity } from "./identity.ts";

type StopReason = Extract<WebRelayState, { status: "stopped" }>["reason"];

export function connectRelay(options: {
  host: string;
  identity: ReturnType<typeof relayIdentity>;
  connecting(): void;
  registered(hostname: string): void;
  stopped(reason: StopReason): void;
  tcp(stream: ServerHttp2Stream, request: IncomingHttpHeaders): void;
  heartbeatTimeout?: number;
}): () => void {
  const url = new URL(`wss://${options.host}${paths.agent}`);
  const controlHost = normalizeControlHost(options.host);
  const proxyValue = process.env.HTTPS_PROXY || process.env.https_proxy;
  const proxy = proxyValue?.startsWith("http://") ? new URL(proxyValue) : undefined;
  let backoff = 1_000;
  let retry: NodeJS.Timeout | undefined;
  let dispose: () => void;

  const attempt = () => {
    options.connecting();
    let finished = false;
    let registeredAt: number | undefined;
    let challenged = false;
    let ws: WebSocket | undefined;
    let duplex: Duplex | undefined;
    let session: ServerHttp2Session | undefined;
    let proxyRequest: ClientRequest | undefined;
    let tunnel: Socket | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const http2 = createServer({ settings: { initialWindowSize: streamWindowSize } });
    const deadline = setTimeout(() => finish(), 30_000);
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(heartbeat);
      proxyRequest?.destroy();
      ws?.terminate();
      session?.destroy();
      duplex?.destroy();
      tunnel?.destroy();
      http2.close();
    };
    const finish = (reason?: StopReason) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (reason !== undefined) {
        options.stopped(reason);
        return;
      }
      options.connecting();
      if (registeredAt !== undefined && performance.now() - registeredAt >= 60_000) backoff = 1_000;
      retry = setTimeout(attempt, backoff * (0.5 + Math.random() * 0.5));
      backoff = Math.min(backoff * 2, 60_000);
    };
    dispose = () => {
      finished = true;
      cleanup();
    };
    const resetHeartbeat = () => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => finish(), options.heartbeatTimeout ?? 60_000);
    };
    http2.on("session", (value) => {
      session = value;
      value.setLocalWindowSize(connectionWindowSize);
      value.on("error", () => ws?.terminate());
      value.once("goaway", () => ws?.terminate());
      value.once("close", () => ws?.close());
    });
    http2.on("stream", (stream, request, _flags, rawHeaders) => {
      stream.on("error", () => stream.destroy());
      if (request[":method"] !== "POST") {
        stream.close(constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      if (request[":path"] === paths.register && !challenged) {
        challenged = true;
        const challenge = request[headers.challenge];
        if (
          typeof challenge !== "string" ||
          rawHeaders.filter((value, index) => index % 2 === 0 && value === headers.challenge)
            .length !== 1 ||
          Buffer.from(challenge, "base64url").length !== 32 ||
          Buffer.from(challenge, "base64url").toString("base64url") !== challenge
        ) {
          ws?.terminate();
          return;
        }
        stream.respond({
          ":status": 200,
          [headers.publicKey]: options.identity.publicKey.toString("base64url"),
          [headers.signature]: sign(
            null,
            Buffer.from(registrationContent(controlHost, challenge)),
            options.identity.privateKey,
          ).toString("base64url"),
        });
        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          body += chunk;
        });
        stream.once("end", () => {
          if (finished) return;
          try {
            const { hostname } = JSON.parse(body) as { hostname: string };
            options.registered(hostname);
            registeredAt = performance.now();
            clearTimeout(deadline);
            stream.end();
          } catch {
            ws?.terminate();
          }
        });
      } else if (request[":path"] === paths.tcp && registeredAt !== undefined) {
        stream.respond({ ":status": 200 });
        options.tcp(stream, request);
      } else {
        stream.close(constants.NGHTTP2_REFUSED_STREAM);
      }
    });
    const open = () => {
      if (finished) return;
      ws = new WebSocket(url, {
        perMessageDeflate: false,
        maxPayload,
        ...(tunnel === undefined
          ? {}
          : {
              createConnection: () =>
                connect({ socket: tunnel, servername: controlHost, ALPNProtocols: ["http/1.1"] }),
            }),
      });
      ws.on("error", () => finish());
      ws.once("unexpected-response", (_request, response) => {
        response.destroy();
        finish(response.statusCode === 404 ? "unsupported-version" : undefined);
      });
      ws.once("close", (code) =>
        finish(
          code === closeCodes.replaced
            ? "replaced"
            : code === closeCodes.invalidSignature
              ? "rejected"
              : undefined,
        ),
      );
      ws.on("ping", resetHeartbeat);
      ws.once("open", () => {
        resetHeartbeat();
        duplex = createWebSocketStream(ws as WebSocket);
        duplex.on("error", () => ws?.terminate());
        http2.emit("connection", duplex);
      });
    };
    if (proxy === undefined) open();
    else {
      proxyRequest = request(proxy, {
        method: "CONNECT",
        path: `${controlHost}:${url.port || "443"}`,
        headers: { host: `${controlHost}:${url.port || "443"}` },
      });
      proxyRequest.on("error", () => finish());
      proxyRequest.once("connect", (response, socket, head) => {
        tunnel = socket;
        if (finished || response.statusCode !== 200) {
          socket.destroy();
          finish();
          return;
        }
        if (head.length) socket.unshift(head);
        open();
      });
      proxyRequest.end();
    }
  };
  attempt();
  return () => {
    clearTimeout(retry);
    dispose();
  };
}
