import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  type ServerHttp2Session,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";
import type { SocketConstructorOpts } from "node:net";
import { connect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { Duplex, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { createWebSocketStream, WebSocket } from "ws";
import {
  deriveId,
  headers,
  paths,
  registrationContent,
  streamWindowSize,
  connectionWindowSize,
  maxPayload,
} from "../src/protocol.js";

export const certPath = fileURLToPath(new URL("./fixtures/cert.pem", import.meta.url));
export const keyPath = fileURLToPath(new URL("./fixtures/key.pem", import.meta.url));
export const credentials = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fakeAgent(
  options: {
    port?: number;
    privateKey?: KeyObject;
    signHost?: string;
    controlHost?: string;
    invalid?: boolean;
    silent?: boolean;
    autoPong?: boolean;
    tcp?: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void;
    registrationHeaders?: OutgoingHttpHeaders;
    controlDelay?: number;
    noticeStatus?: number;
  } = {},
) {
  const privateKey = options.privateKey ?? generateKeyPairSync("ed25519").privateKey;
  const { createPublicKey } = await import("node:crypto");
  const publicKey = Buffer.from(
    createPublicKey(privateKey).export({ format: "jwk" }).x as string,
    "base64url",
  );
  const hostname = `${deriveId(publicKey)}.relay.test`;
  const controlHost = options.controlHost ?? "relay.test";
  // ws forwards SNI to tls.connect, but ClientOptions omits servername.
  const wsOptions = {
    servername: controlHost,
    rejectUnauthorized: false,
    perMessageDeflate: false,
    maxPayload,
    autoPong: options.autoPong ?? true,
  } satisfies WebSocket.ClientOptions & Pick<ConnectionOptions, "servername">;
  const ws = new WebSocket(`wss://127.0.0.1:${options.port ?? 4480}${paths.agent}`, wsOptions);
  const closed = new Promise<number>((resolve) => ws.once("close", resolve));
  ws.on("error", () => {});
  await once(ws, "open");
  const duplex = createWebSocketStream(ws);
  duplex.on("error", () => {});
  // Delay Relay-to-computer bytes to model WINDOW_UPDATE propagation, not per-frame bandwidth.
  const transport = options.controlDelay
    ? Duplex.from({
        readable: duplex.pipe(
          new Transform({
            transform(chunk, _encoding, callback) {
              setTimeout(() => this.push(chunk), options.controlDelay);
              callback();
            },
            final(callback) {
              setTimeout(callback, options.controlDelay);
            },
          }),
        ),
        writable: duplex,
      })
    : duplex;
  transport.on("error", () => {});
  const http2 = createServer({ settings: { initialWindowSize: streamWindowSize } });
  let session!: ServerHttp2Session;
  http2.on("session", (value) => {
    session = value;
    session.setLocalWindowSize(connectionWindowSize);
    session.on("error", () => {});
  });
  const streams: ServerHttp2Stream[] = [];
  const challenges: string[] = [];
  const notices: { quota: string; until: string }[] = [];
  const registered = new Promise<string>((resolve) => {
    http2.on("stream", (stream, request) => {
      stream.on("error", () => {});
      if (request[":path"] === paths.register) {
        const challenge = String(request[headers.challenge]);
        challenges.push(challenge);
        if (options.silent) return;
        const signature = sign(
          null,
          Buffer.from(registrationContent(options.signHost ?? controlHost, challenge)),
          privateKey,
        );
        if (options.invalid) signature[0] = signature.readUInt8(0) ^ 255;
        stream.respond({
          ":status": 200,
          [headers.publicKey]: publicKey.toString("base64url"),
          [headers.signature]: signature.toString("base64url"),
          ...options.registrationHeaders,
        });
        let body = "";
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          if (body) resolve(JSON.parse(body).hostname);
          stream.end();
        });
      } else if (request[":path"] === paths.notice) {
        stream.respond({ ":status": options.noticeStatus ?? 200 });
        if (options.noticeStatus !== undefined && options.noticeStatus !== 200) {
          stream.resume();
          stream.end();
          return;
        }
        let body = "";
        stream.on("data", (chunk) => {
          body += chunk;
        });
        stream.on("end", () => {
          notices.push(JSON.parse(body));
          stream.end();
        });
      } else {
        streams.push(stream);
        stream.respond({ ":status": 200 });
        options.tcp?.(stream, request);
      }
    });
  });
  ws.once("close", () => {
    session.destroy();
    duplex.destroy();
    transport.destroy();
    http2.close();
  });
  http2.emit("connection", transport);
  return {
    ws,
    closed,
    registered,
    privateKey,
    hostname,
    streams,
    challenges,
    notices,
    get session() {
      return session;
    },
  };
}

export function phone(hostname: string, alpn = ["http/1.1"], port = 4480): TLSSocket {
  const options = {
    host: "127.0.0.1",
    port,
    servername: hostname,
    rejectUnauthorized: false,
    ALPNProtocols: alpn,
    allowHalfOpen: false,
  } satisfies ConnectionOptions & Pick<SocketConstructorOpts, "allowHalfOpen">;
  const socket = connect(options);
  socket.on("error", () => {});
  return socket;
}

export function collect(socket: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("error", reject);
  });
}
