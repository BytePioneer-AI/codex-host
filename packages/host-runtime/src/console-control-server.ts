import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { ClientChannelEvents } from "./client-channel-events.js";
import type { ConsoleHostReply } from "./app-server-host.js";
import { matchesBearerToken } from "./bearer-token.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
export const CONSOLE_HOST_DESCRIPTOR_DIRECTORY = path.join("console", "hosts");

export interface ConsoleHostDescriptor {
  schemaVersion: 1;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export interface ConsoleControlTarget {
  clientEvents?: ClientChannelEvents;
  handleConsoleRequest(method: string, params: unknown): Promise<ConsoleHostReply>;
}

export interface ConsoleControlServer {
  descriptorPath: string;
  close(): Promise<void>;
}

export function consoleHostDescriptorDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, CONSOLE_HOST_DESCRIPTOR_DIRECTORY);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Loopback channel through which the local console reaches this Host's
 * settings handling. The console finds it through a per-process descriptor
 * readable only by the user; the token keeps other local users out.
 */
export async function startConsoleControlServer(options: {
  target: ConsoleControlTarget;
  environment: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => number;
}): Promise<ConsoleControlServer> {
  const token = randomBytes(32).toString("hex");
  const pid = options.pid ?? process.pid;
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method === "GET" &&
        request.url === "/display-events" &&
        options.target.clientEvents
      ) {
        if (!matchesBearerToken(request.headers.authorization, token)) {
          reply(response, 401, {});
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        const remove = options.target.clientEvents.subscribe((event) => {
          if (event.type === "hello" || event.type === "display-settings-changed") {
            if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) response.destroy();
          }
        });
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        heartbeat.unref();
        response.on("close", () => {
          remove();
          clearInterval(heartbeat);
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/rpc") {
        reply(response, 404, { error: { code: -32601, message: "Not found" } });
        return;
      }
      if (!matchesBearerToken(request.headers.authorization, token)) {
        reply(response, 401, { error: { code: -32001, message: "Unauthorized" } });
        return;
      }
      let body: unknown;
      try {
        body = await readBody(request);
      } catch {
        reply(response, 400, { error: { code: -32700, message: "Invalid request body" } });
        return;
      }
      const record =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof record.method !== "string") {
        reply(response, 400, { error: { code: -32600, message: "method is required" } });
        return;
      }
      reply(response, 200, await options.target.handleConsoleRequest(record.method, record.params));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        reply(response, 500, {
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
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
  const descriptorPath = path.join(
    consoleHostDescriptorDirectory(options.environment),
    `host-${pid}.json`,
  );
  const descriptor: ConsoleHostDescriptor = {
    schemaVersion: 1,
    pid,
    port: (server.address() as AddressInfo).port,
    token,
    startedAt: (options.now ?? Date.now)(),
  };
  try {
    await writePrivateJson(descriptorPath, descriptor);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    descriptorPath,
    async close() {
      await rm(descriptorPath, { force: true });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
