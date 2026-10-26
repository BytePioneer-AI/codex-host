import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import {
  createFixture,
  method,
  messageParams,
  startPiThread,
  startPiTurn,
  stopFixture,
} from "./app-server-host-fixture.js";

describe("Delegation steering through CLI and Host", () => {
  it.each([true, false])(
    "uses the upstream delivery operation with native support=%s",
    async (native) => {
      let api: DelegationControlApi | undefined;
      const fixture = createFixture({
        onDelegationApi: (value) => {
          api = value;
          return undefined;
        },
      });
      fixture.adapter.supportsSteer = native;
      const threadId = await startPiThread(fixture);
      const originalTurnId = await startPiTurn(fixture, threadId);
      if (!api) throw new Error("Missing Delegation API");
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Missing Session");
      if (!native) session.completeCancellationOnRequest();
      const server = await startDelegationControlServer({ token: "test-token", api });
      try {
        const environment = {
          CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
          CODEXHOST_RUNTIME_TOKEN: "test-token",
        };
        const output = new PassThrough();
        const diagnostics = new PassThrough();
        const args = ["thread", "send", threadId, "--message", "also inspect the tests"];
        expect(
          await runDelegationCli({
            arguments: args,
            environment,
            output,
            diagnosticOutput: diagnostics,
          }),
        ).toBe(1);
        expect(JSON.parse(String(diagnostics.read()))).toMatchObject({
          error: { code: "THREAD_BUSY" },
        });
        expect(
          await runDelegationCli({
            arguments: [...args, "--steer", "true"],
            environment,
            output,
            diagnosticOutput: diagnostics,
          }),
        ).toBe(0);
        const result = JSON.parse(String(output.read())) as { turnId: string };
        if (native) {
          expect(result.turnId).toBe(originalTurnId);
          expect(session.steers).toEqual([
            expect.objectContaining({
              turnId: originalTurnId,
              input: [{ type: "text", text: "also inspect the tests" }],
            }),
          ]);
          expect(
            fixture.collector.messages.filter((message) => message.method === "turn/started"),
          ).toHaveLength(1);
        } else {
          expect(result.turnId).not.toBe(originalTurnId);
          expect(session.steers).toEqual([]);
          expect(
            fixture.collector.messages.filter((message) => message.method === "turn/started"),
          ).toHaveLength(2);
          // CLI input has no Desktop echo, so the stop-then-start path must publish it.
          await expect(
            fixture.collector.waitFor(
              (message) =>
                method(message, "item/started") &&
                (messageParams(message).item as JsonObject).type === "userMessage",
            ),
          ).resolves.toMatchObject({
            params: {
              turnId: result.turnId,
              item: {
                content: [{ type: "text", text: "also inspect the tests" }],
              },
            },
          });
        }
      } finally {
        await server.close();
        await stopFixture(fixture);
      }
    },
  );
});
