import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { BridgeClient, BridgeListener } from "../src/bridge.js";
import { modelRef } from "../src/models.js";
import { TraeCnSession } from "../src/session.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/native-background-command.json", import.meta.url), "utf8"),
);
async function setup() {
  let messageId = "",
    turns = 0,
    done = false;
  const history: Record<string, unknown>[] = [],
    outputs: HarnessOutput[] = [];
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "create") return { sessionId: "session", projectId: "project" };
    if (method === "start") {
      messageId = String(input.messageId);
      turns++;
      return { accepted: true, messageId, fromAppend: false };
    }
    if (method === "snapshot")
      return {
        sessionId: "session",
        status: 5,
        items: history.map((item) =>
          item.commandStatuses
            ? {
                ...item,
                commandStatuses: [
                  {
                    messageId: item.reply_to_message_id,
                    planItemId: "native-plan",
                    commandId: "native-command",
                    status: done ? "succeeded" : "running",
                    output: done ? "DONE\r\n" : "",
                    outputTruncated: false,
                    ...(done ? { exitCode: 0 } : {}),
                  },
                ],
              }
            : item,
        ),
      };
    throw new Error("Unexpected fixture operation: " + method);
  });
  const client = {
    call,
    close: vi.fn(),
    subscribe: vi.fn(async (_input: unknown, listener: BridgeListener) => {
      const userId = messageId,
        index = turns;
      const plan = structuredClone(fixture.plan);
      plan.reply_to_message_id = userId;
      const finish = {
        id: `finish-${index}`,
        reply_to_message_id: userId,
        tool_call_info: {
          name: "finish",
          params: { summary: index === 1 ? "STARTED" : "FOLLOWUP" },
          result: { status: "success" },
        },
        timing: { tool_call_finished_at_ms: 3 },
      };
      history.push(
        {
          role: "user",
          chat_session_id: "session",
          message_id: userId,
          message_index: index * 2 - 1,
          content: JSON.stringify([{ type: "text", text_content: "test" }]),
        },
        {
          role: "assistant",
          chat_session_id: "session",
          message_id: `assistant-${index}`,
          reply_to_message_id: userId,
          message_index: index * 2,
          status: "completed",
          content: JSON.stringify({
            messages: [
              ...(index === 1 ? [{ type: "plan_item", plan_item: plan }] : []),
              { type: "plan_item", plan_item: finish },
            ],
          }),
          ...(index === 1 ? { commandStatuses: [{}] } : {}),
        },
      );
      if (index === 1) listener.event({ event: "plan_item", payload: plan });
      listener.event({ event: "plan_item", payload: finish });
      listener.event({ event: "done" });
      listener.end();
      return vi.fn();
    }),
  };
  const session = new TraeCnSession({
    client: client as unknown as BridgeClient,
    cwd: "/workspace",
    model: modelRef("builder_v3", "configured"),
    inspection: {
      instanceId: "instance",
      application: { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" },
      agentType: "builder_v3",
      workspaceFolders: ["/workspace"],
      models: [{ id: "configured", label: "Configured", provider: "native", multimodal: false }],
      backgroundCommands: { observe: true },
    },
  });
  const consuming = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    session,
    outputs,
    call,
    complete: () => {
      done = true;
    },
    close: async () => {
      await session.close();
      await consuming;
    },
  };
}
const terminal = (outputs: HarnessOutput[], id: string) =>
  outputs.find(
    (output) =>
      output.kind === "event" &&
      output.event.type === "turn.completed" &&
      output.event.turnId === id,
  );
describe("TRAE CN Session with native background commands", () => {
  it("allows a later foreground Turn while the original command stays detached, then records its real result", async () => {
    const test = await setup();
    try {
      await test.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("parent"),
        input: [{ type: "text", text: "background" }],
      });
      await vi.waitFor(() =>
        expect(terminal(test.outputs, "parent")).toMatchObject({
          event: { outcome: { status: "succeeded" } },
        }),
      );
      expect(test.session.hasBackgroundWork()).toBe(true);
      await test.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("later"),
        input: [{ type: "text", text: "followup" }],
      });
      await vi.waitFor(() =>
        expect(terminal(test.outputs, "later")).toMatchObject({
          event: { outcome: { status: "succeeded" } },
        }),
      );
      test.complete();
      await vi.waitFor(() => expect(test.session.hasBackgroundWork()).toBe(false), {
        timeout: 2500,
      });
      const completed = test.outputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "commandExecution",
      );
      expect(completed).toMatchObject([
        {
          event: {
            turnId: "parent",
            snapshot: {
              item: { output: "DONE\r\n", exitCode: 0 },
              outcome: { status: "succeeded" },
            },
          },
        },
      ]);
      const commandResult = completed[0],
        laterResult = terminal(test.outputs, "later");
      if (!commandResult || !laterResult) throw new Error("Missing command/Turn result");
      expect(test.outputs.indexOf(commandResult)).toBeGreaterThan(
        test.outputs.indexOf(laterResult),
      );
      const read = await test.session.readSnapshot();
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.error.message);
      expect(read.value.turns).toHaveLength(2);
      expect(read.value.turns[0]?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            item: expect.objectContaining({ type: "commandExecution", output: "DONE\r\n" }),
          }),
        ]),
      );
      expect(test.call.mock.calls.filter(([method]) => method === "start")).toHaveLength(2);
    } finally {
      await test.close();
    }
  });

  it("ends observation without cancelling or falsely succeeding the native command", async () => {
    const test = await setup();
    await test.session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("parent"),
      input: [{ type: "text", text: "background" }],
    });
    await vi.waitFor(() => expect(terminal(test.outputs, "parent")).toBeDefined());
    await test.close();
    expect(test.call.mock.calls.some(([method]) => method === "cancel")).toBe(false);
    expect(
      test.outputs.filter(
        (output) =>
          output.kind === "event" &&
          output.event.type === "item.completed" &&
          output.event.snapshot.item.type === "commandExecution",
      ),
    ).toMatchObject([
      { event: { snapshot: { outcome: { status: "failed", error: { code: "unavailable" } } } } },
    ]);
    expect(
      test.outputs.filter(
        (output) => output.kind === "event" && output.event.type === "turn.completed",
      ),
    ).toHaveLength(1);
  });
});
