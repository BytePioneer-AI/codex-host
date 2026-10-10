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
}) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      const auth = request.headers.authorization;
      const left = Buffer.from(auth?.startsWith("Bearer ") ? auth.slice(7) : "");
      const right = Buffer.from(token);
      if (request.headers.origin || left.length !== right.length || !timingSafeEqual(left, right)) {
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
    async close() {
      await rm(descriptorPath, { force: true });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
