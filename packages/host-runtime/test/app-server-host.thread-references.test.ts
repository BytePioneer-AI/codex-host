import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import type { JsonObject } from "@codexhost/protocol-core";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import {
  createFixture,
  requestId,
  startPiThread,
  startExternalThread,
  startPiTurn,
  stopFixture,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

it.each([
  ["turn/start", "desktop"],
  ["turn/steer", "desktop"],
  ["turn/start", "client"],
  ["turn/steer", "client"],
] as const)(
  "reads original Host-qualified references through the CLI after %s from %s",
  async (method, origin) => {
    const remoteRead = vi.fn(async () => {
      throw new Error("Desktop forwarding unavailable");
    });
    const registry = new DelegationControlRegistry({ remoteRead });
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const f = createFixture({
      onDelegationApi: (api) => registry.register(api),
      externalAdapters: new Map([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const server = await startDelegationControlServer({ token: "synthetic", api: registry });
    try {
      const targetThreadId = await startPiThread(f);
      const threadId = await startExternalThread(
        f,
        encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("claude-code") }),
        10,
      );
      const session = claude.sessions[0];
      if (!session) throw new Error("Session missing");
      const expectedTurnId = method === "turn/steer" ? await startPiTurn(f, threadId) : undefined;
      const execute = vi.spyOn(session, "execute");
      const reference = `thread://${targetThreadId}?hostId=remote-ssh-discovered%3Amac`;
      const params = {
        threadId,
        ...(expectedTurnId ? { expectedTurnId } : {}),
        clientUserMessageId: "reference-message",
        codexhostSourceHostId: "remote-ssh-discovered:mac",
        input: [{ type: "text", text: reference }],
      };
      const clientReply = origin === "client" ? f.host.handleClientRequest(method, params) : null;
      if (!clientReply) writeRequest(f.desktopInput, { id: 100, method, params });
      if (expectedTurnId) {
        await vi.waitFor(() =>
          expect(execute).toHaveBeenCalledWith({ type: "turn.cancel", turnId: expectedTurnId }),
        );
        session.completeCancellation();
      }
      const response = (await (clientReply ??
        f.collector.waitFor((message) => requestId(message, 100)))) as JsonObject;
      expect(response).not.toHaveProperty("error");
      if (origin === "client") {
        const started = await f.collector.waitFor(
          (message) =>
            message.method === "turn/started" &&
            JSON.stringify(message).includes("reference-message"),
        );
        expect(started).toMatchObject({
          params: {
            turn: {
              items: [
                {
                  type: "userMessage",
                  clientId: "reference-message",
                  content: [{ text: reference }],
                },
              ],
            },
          },
        });
      }
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.start", input: [{ type: "text", text: reference }] }),
      );
      const read = async (ref: string) => {
        const output = new PassThrough();
        const diagnosticOutput = new PassThrough();
        const code = await runDelegationCli({
          arguments: ["thread", "read", ref, "--format", "compact"],
          environment: {
            CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
            CODEXHOST_RUNTIME_TOKEN: "synthetic",
            CODEXHOST_THREAD_ID: threadId,
          },
          output,
          diagnosticOutput,
        });
        return {
          code,
          result: JSON.parse(String((code === 0 ? output : diagnosticOutput).read())),
        };
      };
      expect(await read(reference)).toMatchObject({
        code: 0,
        result: {
          harnessId: "pi",
          thread: reference,
        },
      });
      expect(remoteRead).not.toHaveBeenCalled();
      expect((await read(`thread://${targetThreadId}?hostId=other-host`)).code).toBe(1);
      expect(remoteRead).toHaveBeenCalledOnce();

      // A rejected concurrent submission cannot replace the active Turn's context.
      writeRequest(f.desktopInput, {
        id: 101,
        method: "turn/start",
        params: {
          threadId,
          codexhostSourceHostId: "other-host",
          input: [{ type: "text", text: "rejected" }],
        },
      });
      expect(await f.collector.waitFor((message) => requestId(message, 101))).toHaveProperty(
        "error",
      );
      expect((await read(reference)).code).toBe(0);

      const result = response.result as JsonObject;
      const turnId = method === "turn/steer" ? result.turnId : (result.turn as JsonObject).id;
      session.succeedTurn();
      await f.collector.waitFor((message) => turnEvent(message, "turn/completed", String(turnId)));
      // A later context-free submission clears the previous Desktop's alias.
      await startPiTurn(f, threadId, 102);
      expect((await read(reference)).code).toBe(1);
    } finally {
      await server.close();
      registry.close();
      await stopFixture(f);
    }
  },
);
