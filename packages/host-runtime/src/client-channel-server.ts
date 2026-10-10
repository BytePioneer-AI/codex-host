import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  clientChannelCursorSchema,
  clientChannelResponseSchema,
  type ClientThreadSnapshot,
  type ClientChannelResponse,
} from "@codexhost/shared-contracts";
import type { ClientChannelEvents } from "./client-channel-events.js";
import { WebSocketServer } from "ws";
import { attachRemoteAppServerSession } from "./remote-app-server-session.js";
import type { RemoteAppServerSessionStreams, RemoteAppServerSession } from "./remote-app-server.js";

export interface ClientChannelTarget {
  readonly clientEvents: ClientChannelEvents;
  handleClientRequest(method: string, params: unknown): Promise<unknown>;
  clientSnapshot(threadId: string): Promise<ClientThreadSnapshot>;
  respondClient(input: ClientChannelResponse): Promise<{ resolved: boolean }>;
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request) {
    const buffer = Buffer.from(part as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("Client request is too large");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

/** Only loopback, authenticated Node peers can reach the owner. Apps connect via
 * their authenticated gateway, never receive this private discovery token. */
export async function startClientChannelServer(options: {
  target: ClientChannelTarget;
  environment: NodeJS.ProcessEnv;
  directory?: string;
  owner?: "service";
  shutdown?: () => void;
  desktopSession?: (
    streams: RemoteAppServerSessionStreams,
    request: IncomingMessage,
  ) => RemoteAppServerSession;
}) {
  const token = randomBytes(32).toString("hex");
  const authorized = (request: IncomingMessage): boolean => {
    const auth = request.headers.authorization;
    const left = Buffer.from(auth?.startsWith("Bearer ") ? auth.slice(7) : "");
    const right = Buffer.from(token);
    return !request.headers.origin && left.length === right.length && timingSafeEqual(left, right);
  };
  const server = createServer((request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (!authorized(request)) {
        reply(401, { error: { code: -32001, message: "Unauthorized" } });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = url.searchParams.has("epoch")
          ? clientChannelCursorSchema.parse({
              epoch: url.searchParams.get("epoch"),
              sequence: Number(url.searchParams.get("after")),
            })
          : undefined;
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
        });
        const remove = options.target.clientEvents.subscribe((event) => {
          if (response.writableLength > 256 * 1024) {
            response.destroy();
            throw new Error("Slow client detached");
          }
          response.write(JSON.stringify(event) + "\n");
        }, after);
        const heartbeat = setInterval(() => response.write("\n"), 15_000);
        heartbeat.unref();
        response.on("close", () => {
          clearInterval(heartbeat);
          remove();
        });
        return;
      }
      if (request.method !== "POST") {
        reply(404, { error: { code: -32601, message: "Not found" } });
        return;
      }
      const input = await body(request);
      if (url.pathname === "/v1/shutdown" && options.shutdown) {
        response.once("finish", () => setImmediate(() => options.shutdown?.()));
        reply(200, { result: { stopping: true } });
        return;
      }
      if (url.pathname === "/v1/rpc" && typeof input.method === "string")
        reply(200, await options.target.handleClientRequest(input.method, input.params));
      else if (url.pathname === "/v1/snapshot" && typeof input.threadId === "string")
        reply(200, { result: await options.target.clientSnapshot(input.threadId) });
      else if (url.pathname === "/v1/respond")
        reply(200, {
          result: await options.target.respondClient(clientChannelResponseSchema.parse(input)),
        });
      else reply(404, { error: { code: -32601, message: "Not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent)
        reply(400, {
          error: {
            code: -32602,
            message: error instanceof Error ? error.message : "Client operation failed",
          },
        });
      else response.destroy();
    });
  });
  const desktop = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
  const desktopSessions = new Set<ReturnType<typeof attachRemoteAppServerSession>>();
  let closing: Promise<void> | undefined;
  server.on("upgrade", (request, socket, head) => {
    const session = options.desktopSession;
    if (closing || !session || request.url !== "/v1/desktop" || !authorized(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    desktop.handleUpgrade(request, socket, head, (connection) => {
      try {
        const binding = attachRemoteAppServerSession({
          socket: connection,
          framing: "ndjson",
          diagnosticOutput: process.stderr,
          createSession: (streams) => session(streams, request),
        });
        desktopSessions.add(binding);
        void binding.running.finally(() => desktopSessions.delete(binding));
      } catch {
        connection.on("error", () => undefined);
        connection.close(1008, "Invalid Desktop runtime context");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const directory =
    options.directory ??
    path.join(
      options.environment.CODEXHOST_DATA_DIR ?? path.join(homedir(), ".codexhost"),
      "client-hosts",
    );
  const descriptorPath = path.join(
    directory,
    `host-${process.pid}-${options.target.clientEvents.epoch}.json`,
  );
  const temporary = `${descriptorPath}.${randomBytes(8).toString("hex")}.tmp`;
  const descriptor = {
    version: 1 as const,
    ...(options.owner ? { owner: options.owner } : {}),
    pid: process.pid,
    port: (server.address() as AddressInfo).port,
    token,
    startedAt: Date.now(),
    epoch: options.target.clientEvents.epoch,
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(descriptor), { flag: "wx", mode: 0o600 });
    await rename(temporary, descriptorPath);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    descriptorPath,
    descriptor,
    close(): Promise<void> {
      return (closing ??= (async () => {
        for (const session of desktopSessions) session.close();
        for (const client of desktop.clients) client.terminate();
        desktop.close();
        const closed = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await rm(descriptorPath, { force: true });
        await Promise.all([closed, ...[...desktopSessions].map((session) => session.running)]);
      })());
    },
  };
}
