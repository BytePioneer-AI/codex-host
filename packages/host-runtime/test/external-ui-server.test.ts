import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  externalUiDescriptorPath,
  startExternalUiServer,
  type ExternalUiDescriptorV1,
} from "../src/external-ui-server.js";
import { SharedThreadOwner } from "../src/shared-thread-owner.js";

let dataDirectory: string;

beforeEach(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-external-ui-"));
});

afterEach(async () => {
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("external UI server", () => {
  it("publishes a private descriptor, requires its token, and bridges app-server frames", async () => {
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    let received = "";
    const server = await startExternalUiServer({
      environment,
      diagnosticOutput: new PassThrough(),
      pid: 4242,
      now: () => 123456,
      createSession: ({ input, output }) => ({
        async run() {
          input.setEncoding("utf8");
          for await (const chunk of input) {
            received += chunk;
            output.write(chunk);
          }
          output.end();
          return 0;
        },
        disconnect: () => (input as PassThrough).end(),
        close: () => (input as PassThrough).end(),
      }),
    });

    try {
      expect(server.descriptorPath).toBe(externalUiDescriptorPath(environment));
      const descriptor = JSON.parse(
        await readFile(server.descriptorPath, "utf8"),
      ) as ExternalUiDescriptorV1;
      expect(descriptor).toMatchObject({
        schemaVersion: 1,
        protocolVersion: 1,
        pid: 4242,
        host: "127.0.0.1",
        startedAt: 123456,
      });
      if (process.platform !== "win32") {
        expect((await stat(server.descriptorPath)).mode & 0o777).toBe(0o600);
      }

      const unauthorized = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`);
      const [, response] = (await once(unauthorized, "unexpected-response")) as [
        unknown,
        { statusCode?: number },
      ];
      expect(response.statusCode).toBe(401);

      const client = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      });
      await once(client, "open");
      client.send('{"id":1,"method":"initialize"}');
      const [message, binary] = (await once(client, "message")) as [Buffer, boolean];
      expect(binary).toBe(false);
      expect(message.toString("utf8")).toBe('{"id":1,"method":"initialize"}');
      expect(received).toBe('{"id":1,"method":"initialize"}\n');
      client.close();
      await once(client, "close");
    } finally {
      await server.close();
    }
    await expect(stat(server.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("external UI session lifecycle", () => {
  it("treats a SharedThreadOwner viewer disconnect as a normal session exit", async () => {
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    const owner = new SharedThreadOwner();
    const diagnosticOutput = new PassThrough();
    let diagnostics = "";
    diagnosticOutput.setEncoding("utf8");
    diagnosticOutput.on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    const server = await startExternalUiServer({
      environment,
      diagnosticOutput,
      createSession: (streams) => owner.createSession(streams),
    });

    try {
      const descriptor = server.descriptor;
      const client = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      });
      await once(client, "open");
      client.close();
      await once(client, "close");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(diagnostics).not.toContain("Premature close");
    } finally {
      await server.close();
      owner.close();
      owner.output.end();
    }
  });

  it("disconnects transport without hard-cancelling and waits for shutdown", async () => {
    const environment = { CODEXHOST_DATA_DIR: dataDirectory };
    let finishSession = (): void => undefined;
    const disconnectSession = vi.fn();
    const closeSession = vi.fn(() => finishSession());

    const server = await startExternalUiServer({
      environment,
      diagnosticOutput: new PassThrough(),
      createSession: ({ input }) => {
        disconnectSession.mockImplementation(() => (input as PassThrough).end());
        return {
          run: () =>
            new Promise<number>((resolve) => {
              finishSession = () => resolve(0);
            }),
          disconnect: disconnectSession,
          close: closeSession,
        };
      },
    });

    try {
      const descriptor = server.descriptor;
      const client = new WebSocket(`ws://127.0.0.1:${descriptor.port}/`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
      });
      await once(client, "open");
      client.close();
      await once(client, "close");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(disconnectSession).toHaveBeenCalledOnce();
      expect(closeSession).not.toHaveBeenCalled();

      await Promise.all([server.close(), server.close()]);
      expect(closeSession).toHaveBeenCalledOnce();
    } finally {
      finishSession();
      await server.close();
    }
  });
});
