import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { allowedHost } from "./request-guard.js";

interface RuntimeDescriptor {
  host: "127.0.0.1";
  port: number;
  token: string;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}

async function descriptor(filePath: string): Promise<RuntimeDescriptor> {
  const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!value || typeof value !== "object") {
    throw new Error("External UI descriptor is unavailable");
  }
  const record = value as Record<string, unknown>;
  if (
    record.host !== "127.0.0.1" ||
    typeof record.port !== "number" ||
    typeof record.token !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.token)
  ) {
    throw new Error("External UI descriptor is invalid");
  }
  return {
    host: "127.0.0.1",
    port: record.port,
    token: record.token,
  };
}

export function createExternalUiProxy(options: {
  descriptorPath: string;
  port(): number;
}) {
  const webSockets = new WebSocketServer({ noServer: true });

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean => {
    const port = options.port();
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/api/external-ui") return false;

    const origin = request.headers.origin;
    const allowedOrigin =
      origin === undefined ||
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}`;
    if (!allowedHost(request.headers.host, port) || !allowedOrigin) {
      reject(socket, 403, "Forbidden");
      return true;
    }

    webSockets.handleUpgrade(request, socket, head, (client) => {
      void descriptor(options.descriptorPath).then(
        (runtime) => {
          const upstream = new WebSocket(
            `ws://${runtime.host}:${runtime.port}/`,
            { headers: { authorization: `Bearer ${runtime.token}` } },
          );
          const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];

          client.on("message", (data, binary) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data, { binary });
            } else if (upstream.readyState === WebSocket.CONNECTING) {
              pending.push({ data, binary });
            }
          });

          upstream.once("open", () => {
            for (const message of pending) {
              upstream.send(message.data, { binary: message.binary });
            }
            pending.length = 0;
          });
          upstream.on("message", (data, binary) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(data, { binary });
            }
          });
          upstream.once("error", () => {
            if (client.readyState === WebSocket.OPEN) {
              client.close(1011, "CodexHost External UI unavailable");
            }
          });
          upstream.once("close", () => {
            if (client.readyState === WebSocket.OPEN) client.close(1000);
          });
          client.once("close", () => upstream.close());
          client.once("error", () => upstream.close());
        },
        () => client.close(1011, "CodexHost External UI unavailable"),
      );
    });
    return true;
  };

  return {
    handleUpgrade,
    close(): void {
      for (const client of webSockets.clients) client.terminate();
      webSockets.close();
    },
  };
}
