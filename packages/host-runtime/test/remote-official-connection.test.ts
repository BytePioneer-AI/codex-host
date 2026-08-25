import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createRemoteAppServerWebSocketListener } from "../src/remote-app-server.js";
import { createRemoteOfficialAppServerConnection } from "../src/remote-official-connection.js";

function testSocketPath(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codexhost-official-${process.pid}-${Date.now()}`
    : path.join("/tmp", `ch-official-${process.pid}-${Date.now()}`, "control.sock");
}

async function readFrame(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let pending = "";
  return new Promise((resolve) => {
    const onData = (chunk: string): void => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      stream.off("data", onData);
      resolve(pending.slice(0, newline));
    };
    stream.on("data", onData);
  });
}

describe("remote official app-server connection", () => {
  it("connects multiple LF-JSON clients to one loopback WebSocket listener", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ server });
    webSockets.on("connection", (webSocket) => {
      webSocket.on("message", (data) => webSocket.send(data, { binary: false }));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const endpoint = `ws://127.0.0.1:${address.port}`;
      const first = await createRemoteOfficialAppServerConnection(endpoint);
      const second = await createRemoteOfficialAppServerConnection(endpoint);
      const firstFrame = readFrame(first.stdout);
      const secondFrame = readFrame(second.stdout);

      first.stdin.write('{"id":1,"method":"initialize"}\n');
      second.stdin.write('{"id":2,"method":"thread/resume"}\n');

      await expect(firstFrame).resolves.toBe('{"id":1,"method":"initialize"}');
      await expect(secondFrame).resolves.toBe('{"id":2,"method":"thread/resume"}');
      expect(webSockets.clients.size).toBe(2);
      first.close();
      second.close();
      await Promise.all([first.closed, second.closed]);
    } finally {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("matches the native client handshake without offering permessage-deflate", async () => {
    const socketPath = testSocketPath();
    const server = createServer();
    const webSockets = new WebSocketServer({ noServer: true });
    let extensions: string | undefined;
    server.on("upgrade", (request, socket, head) => {
      extensions = request.headers["sec-websocket-extensions"];
      if (extensions) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request);
      });
    });
    webSockets.on("connection", (webSocket) => {
      webSocket.on("message", (data) => webSocket.send(data, { binary: false }));
    });

    try {
      if (process.platform !== "win32") await mkdir(path.dirname(socketPath), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const connection = await createRemoteOfficialAppServerConnection(socketPath);
      const frame = readFrame(connection.stdout);

      connection.stdin.write('{"id":1,"method":"initialize"}\n');

      await expect(frame).resolves.toBe('{"id":1,"method":"initialize"}');
      expect(extensions).toBeUndefined();
      connection.close();
      await connection.closed;
    } finally {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
  });

  it("performs a WebSocket handshake for two LF-JSON clients against one listener", async () => {
    const socketPath = testSocketPath();
    let sessionCount = 0;
    const listener = createRemoteAppServerWebSocketListener({
      socketPath,
      diagnosticOutput: new PassThrough(),
      createSession: ({ input, output }) => ({
        async run() {
          sessionCount += 1;
          input.pipe(output);
          await new Promise<void>((resolve) => input.once("close", resolve));
          return 0;
        },
        close: () => input.destroy(),
      }),
    });

    try {
      await listener.listen();
      const first = await createRemoteOfficialAppServerConnection(socketPath);
      const second = await createRemoteOfficialAppServerConnection(socketPath);
      const firstFrame = readFrame(first.stdout);
      const secondFrame = readFrame(second.stdout);

      first.stdin.write('{"id":1,"method":"initialize"}\n');
      second.stdin.write('{"id":2,"method":"thread/resume"}\n');

      await expect(firstFrame).resolves.toBe('{"id":1,"method":"initialize"}');
      await expect(secondFrame).resolves.toBe('{"id":2,"method":"thread/resume"}');
      expect(sessionCount).toBe(2);
      first.close();
      second.close();
      await Promise.all([first.closed, second.closed]);
    } finally {
      await listener.close();
      if (process.platform !== "win32") {
        await rm(path.dirname(socketPath), { recursive: true, force: true });
      }
    }
  });
});
