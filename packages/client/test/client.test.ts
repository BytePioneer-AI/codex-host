import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  CodexHostClient,
  externalHarnessTransportModel,
  readRuntimeDescriptor,
  runtimeDescriptorPath,
} from "../src/index.js";

let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-client-"));
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("@codexhost/client", () => {
  it("reads runtime descriptor from CODEXHOST_DATA_DIR", async () => {
    const descriptor = {
      schemaVersion: 1,
      protocolVersion: 1,
      pid: 123,
      host: "127.0.0.1",
      port: 4567,
      token: "abc",
      startedAt: 999,
    } as const;
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    await writeFile(runtimeDescriptorPath(environment), JSON.stringify(descriptor), "utf8");
    await expect(readRuntimeDescriptor(environment)).resolves.toEqual(descriptor);
  });

  it("encodes plugin Harness routes without protocol-core", () => {
    expect(externalHarnessTransportModel("sample-agent")).toBe(
      "codexhost/plugin-v1@7b226861726e6573734964223a2273616d706c652d6167656e74227d",
    );
    expect(() => externalHarnessTransportModel("codex")).toThrow("Invalid external Harness ID");
  });

  it("connects, sends JSON-RPC requests, and emits notifications", async () => {
    const httpServer = createServer();
    const webSockets = new WebSocketServer({ server: httpServer });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture listener did not expose a TCP port");
    }

    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    await writeFile(
      runtimeDescriptorPath(environment),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        pid: process.pid,

        host: "127.0.0.1",
        port: address.port,
        token: "fixture-token",
        startedAt: Date.now(),
      }),
      "utf8",
    );

    webSockets.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer fixture-token");
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id: number;
          method: string;
        };
        if (message.id === undefined) return;
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { ok: message.method },
          }),
        );
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "fixture/notification",
            params: { value: 1 },
          }),
        );
      });
    });

    const client = await CodexHostClient.connect(environment);
    try {
      const notification = once(client, "notification");
      await expect(client.request("fixture/ping", {})).resolves.toEqual({
        ok: "fixture/ping",
      });
      await expect(notification).resolves.toEqual(["fixture/notification", { value: 1 }]);
    } finally {
      client.close();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe("@codexhost/client server requests", () => {
  it("emits server requests and sends responses with the same id", async () => {
    const httpServer = createServer();
    const webSockets = new WebSocketServer({ server: httpServer });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture listener did not expose a TCP port");
    }

    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    await writeFile(
      runtimeDescriptorPath(environment),
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 1,
        pid: process.pid,
        host: "127.0.0.1",
        port: address.port,
        token: "fixture-token",
        startedAt: Date.now(),
      }),
      "utf8",
    );

    const serverReply = Promise.withResolvers<unknown>();
    webSockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          id?: string | number;
          method?: string;
          result?: unknown;
        };
        if (message.method) {
          if (message.id === undefined) return;
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { ok: message.method },
          }));
          if (message.method === "fixture/trigger") {
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: "codexhost:server:fixture:7",
              method: "item/commandExecution/requestApproval",
              params: { threadId: "thread-1", reason: "Allow?" },
            }));
          }
          return;
        }
        if (message.id === "codexhost:server:fixture:7") serverReply.resolve(message.result);
      });
    });

    const client = await CodexHostClient.connect(environment);
    try {
      const incoming = once(client, "serverRequest");
      await client.request("fixture/trigger", {});
      await expect(incoming).resolves.toEqual([
        "codexhost:server:fixture:7",
        "item/commandExecution/requestApproval",
        { threadId: "thread-1", reason: "Allow?" },
      ]);
      client.respond("codexhost:server:fixture:7", { decision: "accept" });
      await expect(serverReply.promise).resolves.toEqual({ decision: "accept" });
    } finally {
      client.close();
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
