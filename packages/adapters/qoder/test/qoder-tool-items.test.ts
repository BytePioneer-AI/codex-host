import { describe, expect, it } from "vitest";
import { HarnessOutputChannel, type HostToolExecutionItem } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import { QoderSession } from "../src/qoder-sdk-transport.js";
import { mapQoderSnapshot } from "../src/qoder-history.js";
import type { SDKMessage, SessionMessage } from "../src/qoder-sdk-types.js";

// Pi/OMP already use the shared Write/Edit compatibility path. Qoder must not
// require a new namespace rule or a native patch to retain that same behavior.
describe("Qoder existing tool projection", () => {
  it.each([
    { name: "Write", args: { file_path: "a.txt", content: "hello" } },
    { name: "Edit", args: { file_path: "a.txt", old_string: "hello", new_string: "world" } },
  ])(
    "keeps the existing live/history projection for $name without a native patch",
    async ({ name, args }) => {
      const messages = new HarnessOutputChannel<SDKMessage>();
      const session = new QoderSession({
        sessionId: "native-session",
        cwd: "D:/workspace",
        queryFactory: () => ({
          [Symbol.asyncIterator]: () => messages.outputs[Symbol.asyncIterator](),
          interrupt: async () => {},
          close: async () => messages.end(),
        }),
      });
      const turnId = hostTurnIdSchema.parse("turn");
      const projector = new CodexTurnProjector({
        threadId: "host-thread",
        turnId,
        cwd: "D:/workspace",
        startedAtMs: 1,
      });
      const assistant = {
        type: "assistant",
        uuid: "assistant",
        message: { content: [{ type: "tool_use", id: "tool", name, input: args }] },
      };
      const result = {
        type: "user",
        uuid: "tool-result",
        message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] },
      };
      const wire: unknown[] = [];
      const tools: HostToolExecutionItem[] = [];
      const collected = (async () => {
        for await (const output of session.outputs) {
          if (output.kind !== "event") continue;
          const event = output.event;
          if (event.type === "item.completed" && event.snapshot.item.type === "toolExecution") {
            tools.push(event.snapshot.item);
          }
          if (
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed" ||
            event.type === "turn.started" ||
            event.type === "turn.completed"
          ) {
            wire.push(...projector.project(event).messages);
          }
          if (event.type === "turn.completed") break;
        }
      })();
      try {
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "edit" }],
        });
        messages.emit(assistant as SDKMessage);
        messages.emit(result as SDKMessage);
        messages.emit({ type: "result", subtype: "success" } as SDKMessage);
        await collected;
        expect(tools).toHaveLength(1);
        expect(tools[0]).not.toHaveProperty("namespace");
        expect(tools[0]).toMatchObject({ toolName: name, arguments: args });
        expect(wire).toContainEqual(
          expect.objectContaining({
            method: "item/completed",
            params: expect.objectContaining({
              item: expect.objectContaining({ type: "fileChange" }),
            }),
          }),
        );
        const snapshot = mapQoderSnapshot(
          [
            { type: "user", uuid: "user", message: { content: "edit" } },
            assistant,
            result,
          ] as SessionMessage[],
          "native-session",
        ).turns[0];
        if (!snapshot) throw new Error("Missing history");
        expect(projectHistoricalTurn({ turnId, cwd: "D:/workspace", snapshot })).toMatchObject({
          items: [{ type: "userMessage" }, { type: "fileChange" }],
        });
      } finally {
        await session.close();
      }
    },
  );
});
