import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { WebSocketServer } from "ws";
import { readClientHello } from "./client-hello.js";
import { ControlCertificate } from "./certificates.js";
import { isDnsLabel, maxPayload, normalizeControlHost, paths } from "./protocol.js";
import { forward } from "./forward.js";
import {
  registerAgent,
  type Agent,
  type RegistrationRequest,
  type RegistrationResult,
} from "./registration.js";
import { pruneUsage, type Usage } from "./usage.js";

import type { ConnectionEvent, UsageDetails } from "./events.js";

export type { RegistrationRequest, RegistrationResult } from "./registration.js";
export type { ConnectionEvent, UsageDetails } from "./events.js";

export interface RelayOptions {
  domain: string;
  controlHost?: string;
  cert?: string;
  key?: string;
  dataDir?: string;
  heartbeatInterval?: number;
  rate?: number;
  dailyQuota?: number;
  maxConnections?: number;
  check?: (request: RegistrationRequest) => RegistrationResult | Promise<RegistrationResult>;
  onUsage?: (name: string, bytes: number, details: UsageDetails) => void;
  onConnection?: (event: ConnectionEvent) => void;
  onRequest?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

export function createRelay(options: RelayOptions) {
  const { maxConnections } = options;
  if (
    maxConnections !== undefined &&
    (!Number.isSafeInteger(maxConnections) || maxConnections < 1)
  ) {
    throw new Error("--max-connections must be a positive integer");
  }
  const domain = normalizeControlHost(options.domain);
  const controlHost = normalizeControlHost(options.controlHost ?? `relay.${domain}`);
  if ((options.cert === undefined) !== (options.key === undefined)) {
    throw new Error("--cert and --key must be provided together");
  }
  const agents = new Map<string, Agent>();
  const usageByName = new Map<string, Usage>();
  const sockets = new Set<Socket>();
  const credentials = () => ({
    cert: readFileSync(options.cert as string),
    key: readFileSync(options.key as string),
  });
  const http = createHttpServer(async (request, response) => {
    try {
      if (options.onRequest) await options.onRequest(request, response);
      else response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    }
  });
  const tls = createTlsServer(
    { ...(options.cert ? credentials() : {}), ALPNProtocols: ["http/1.1"] },
    (socket) => http.emit("connection", socket),
  );
  tls.on("tlsClientError", (_error, socket) => socket.destroy());
  const certificates = options.cert
    ? undefined
    : new ControlCertificate(tls, controlHost, options.dataDir ?? "./data");
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload });
  http.on("upgrade", (request, socket, head) => {
    if (request.url !== paths.agent) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      registerAgent(
        ws,
        agents,
        usageByName,
        { ...options, domain, controlHost },
        request.socket.remoteAddress,
      );
    });
  });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    // A phone that disappears after its ClientHello can make the stream request throw; that
    // must close this connection, not reject unhandled and stop the whole Relay.
    void readClientHello(socket)
      .then(({ servername, alpn }) => {
        const hostname = servername.toLowerCase();
        if (hostname === controlHost) {
          if (alpn.length === 1 && alpn[0] === "acme-tls/1") {
            if (certificates?.verifying) certificates.challenge.emit("connection", socket);
            else socket.destroy();
          } else if (!certificates || certificates.available) {
            tls.emit("connection", socket);
          } else socket.destroy();
          return;
        }
        const suffix = `.${domain}`;
        const name = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
        const agent = isDnsLabel(name) ? agents.get(name) : undefined;
        const usage = usageByName.get(name);
        if (!agent || !usage) {
          socket.destroy();
          return;
        }
        forward(
          socket,
          agent,
          name,
          usage,
          alpn.length === 1 && alpn[0] === "acme-tls/1",
          options.onUsage,
          options.onConnection,
        );
      })
      .catch(() => socket.destroy());
  });
  if (maxConnections !== undefined) server.maxConnections = maxConnections;
  const cleanupUsage = setInterval(() => pruneUsage(usageByName, agents), 60 * 60_000);
  cleanupUsage.unref();
  const reload = () => tls.setSecureContext(credentials());
  if (certificates) server.once("listening", () => certificates.start());
  else process.on("SIGHUP", reload);
  return {
    server,
    disconnect(name: string): void {
      agents.get(name.toLowerCase())?.close(1000);
    },
    async close(): Promise<void> {
      certificates?.stop();
      clearInterval(cleanupUsage);
      process.off("SIGHUP", reload);
      const closed = [...wss.clients, ...sockets].map(
        (connection) => new Promise<void>((resolve) => connection.once("close", () => resolve())),
      );
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(closed);
    },
  };
}
