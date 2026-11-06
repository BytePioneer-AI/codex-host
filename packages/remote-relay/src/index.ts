import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { WebSocketServer } from "ws";
import { readClientHello } from "./client-hello.js";
import { maxPayload, normalizeControlHost, paths } from "./protocol.js";
import { forward } from "./forward.js";
import { registerAgent, type Agent } from "./registration.js";
import { Usage } from "./usage.js";

export interface RelayOptions {
  domain: string;
  controlHost?: string;
  cert: string;
  key: string;
  heartbeatInterval?: number;
  rate?: number;
  dailyQuota?: number;
}

export function createRelay(options: RelayOptions) {
  const domain = normalizeControlHost(options.domain);
  const controlHost = normalizeControlHost(options.controlHost ?? domain);
  const agents = new Map<string, Agent>();
  const usageById = new Map<string, Usage>();
  const sockets = new Set<Socket>();
  const credentials = () => ({ cert: readFileSync(options.cert), key: readFileSync(options.key) });
  const http = createHttpServer((_request, response) => {
    response.writeHead(404).end();
  });
  const tls = createTlsServer({ ...credentials(), ALPNProtocols: ["http/1.1"] }, (socket) => {
    http.emit("connection", socket);
  });
  tls.on("tlsClientError", (_error, socket) => socket.destroy());
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
        domain,
        controlHost,
        options.heartbeatInterval ?? 25_000,
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
        const name = servername.toLowerCase();
        if (name === controlHost) {
          tls.emit("connection", socket);
          return;
        }
        const suffix = `.${domain}`;
        const id = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
        const agent = /^[a-z2-7]{26}$/.test(id) ? agents.get(id) : undefined;
        if (!agent) {
          socket.destroy();
          return;
        }
        let usage = usageById.get(id);
        if (!usage) {
          usage = new Usage(options.rate, options.dailyQuota);
          usageById.set(id, usage);
        }
        forward(socket, agent, id, usage, alpn.length === 1 && alpn[0] === "acme-tls/1");
      })
      .catch(() => socket.destroy());
  });
  const reload = () => tls.setSecureContext(credentials());
  process.on("SIGHUP", reload);
  return {
    server,
    async close(): Promise<void> {
      process.off("SIGHUP", reload);
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
