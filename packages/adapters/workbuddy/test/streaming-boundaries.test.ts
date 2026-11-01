import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeBuddyClientFactory, CodeBuddyClientHandlers } from "@codexhost/adapter-codebuddy";
import type { HostEvent, HostThreadSnapshot } from "@codexhost/harness-adapter";
import { CodexTurnProjector, projectHistoricalTurn } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const adapters: WorkBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

// WorkBuddy's native prompt forwarder deliberately reuses the top-level ID;
// codebuddy.ai/llmMessageId identifies each model response within that Prompt.
function message(body: string, llm: string, thought = false) {
  return {
    sessionUpdate: thought ? ("agent_thought_chunk" as const) : ("agent_message_chunk" as const),
    messageId: "native-session-prompt-request",
    content: { type: "text" as const, text: body },
    _meta: {
      "codebuddy.ai/messageId": "native-session-prompt-request",
      "codebuddy.ai/llmMessageId": llm,
    },
  };
}

describe("WorkBuddy live reply boundaries", () => {
  it.each(["Read", "Agent"])(
    "keeps the answer after %s outside activity and closes preceding text before the tool",
    async (toolName) => {
      let handlers: CodeBuddyClientHandlers | undefined;
      const terminal = Promise.withResolvers<Record<string, unknown>>();
      const rows: Record<string, unknown>[] = [];
      const clientFactory: CodeBuddyClientFactory = (options) => {
        handlers = options.handlers;
        return {
          initialize: async () => ({ protocolVersion: 1 }),
          open: async () => ({
            sessionId: "native-session",
            configOptions: [
              {
                id: "model",
                currentValue: "native/model",
                options: [{ value: "native/model", name: "Model" }],
              },
              {
                id: "mode",
                currentValue: "default",
                options: [{ value: "default", name: "Default" }],
              },
              {
                id: "thought_level",
                currentValue: "low",
                options: [{ value: "low", name: "Low" }],
              },
            ],
          }),
          configure: async () => ({}),
          prompt: async () => {
            rows.push({
              id: "user",
              type: "message",
              role: "user",
              content: "Summarize architecture",
            });
            return terminal.promise;
          },
          cancel: async () => {},
          answer: async () => {},
          close: async () => {
            terminal.resolve({ stopReason: "cancelled" });
          },
        };
      };
      const adapter = new WorkBuddyAdapter({
        clientFactory,
        readHistory: async () => rows.map((row) => JSON.stringify(row)).join("\n"),
      });
      adapters.push(adapter);
      const opened = await adapter.open({ kind: "create", cwd: process.cwd(), environment: {} });
      if (!opened.ok) throw Error(opened.error.message);
      const session = opened.value;
      const turnId = hostTurnIdSchema.parse("workbuddy-stream");
      const projector = new CodexTurnProjector({
        threadId: "thread",
        turnId,
        cwd: process.cwd(),
        startedAtMs: Date.now(),
      });
      const events: HostEvent[] = [];
      let completedTurn: ReturnType<CodexTurnProjector["project"]>["completedTurn"];
      const collecting = (async () => {
        for await (const output of session.outputs) {
          if (output.kind !== "event") continue;
          const event = output.event;
          events.push(event);
          if (!("turnId" in event) || event.type === "turn.autonomous.started") continue;
          const result = projector.project(event);
          if (result.completedTurn) completedTurn = result.completedTurn;
        }
      })();
      try {
        expect(
          await session.execute({
            type: "turn.start",
            turnId,
            input: [{ type: "text", text: "Summarize architecture" }],
          }),
        ).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(rows).toHaveLength(1));
        if (!handlers) throw Error("Missing ACP handlers");
        const update: CodeBuddyClientHandlers["update"] = (notification) =>
          handlers?.update(notification);
        const send = (value: Parameters<CodeBuddyClientHandlers["update"]>[0]["update"]) =>
          update({ sessionId: "native-session", update: value });
        send(message("First analysis", "model-before", true));
        send(message("Checking the repository.", "model-before"));
        const arguments_ =
          toolName === "Agent"
            ? {
                description: "Explore architecture",
                subagent_type: "Explore",
                prompt: "Explore architecture",
              }
            : { file_path: "README.md" };
        send({
          sessionUpdate: "tool_call",
          toolCallId: "call",
          title: toolName,
          status: "in_progress",
          rawInput: arguments_,
          _meta: { "codebuddy.ai/toolName": toolName, "codebuddy.ai/toolArgumentsComplete": true },
        });
        await vi.waitFor(() =>
          expect(
            events.some(
              (event) =>
                event.type === "item.started" &&
                event.item.type === (toolName === "Agent" ? "subagentDelegation" : "toolExecution"),
            ),
          ).toBe(true),
        );
        const toolStart = events.findIndex(
          (event) =>
            event.type === "item.started" &&
            event.item.type === (toolName === "Agent" ? "subagentDelegation" : "toolExecution"),
        );
        expect(
          events.slice(0, toolStart).filter((event) => event.type === "item.completed"),
        ).toMatchObject([
          { snapshot: { item: { type: "reasoning", text: "First analysis" } } },
          { snapshot: { item: { type: "agentMessage", text: "Checking the repository." } } },
        ]);
        send({
          sessionUpdate: "tool_call_update",
          toolCallId: "call",
          status: "completed",
          rawOutput: { type: "text", text: "done" },
        });
        send(message("Second analysis", "model-after", true));
        send(message("Final architecture answer.", "model-after"));
        // Child notifications must neither appear in the parent nor close its text.
        send({
          ...message("child reply", "child-model"),
          _meta: {
            "codebuddy.ai/parentToolCallId": "call",
            "codebuddy.ai/llmMessageId": "child-model",
          },
        });
        send(message(" More detail.", "model-after"));
        rows.push({
          id: "final",
          parentId: "user",
          type: "message",
          role: "assistant",
          status: "completed",
          content: "Final architecture answer. More detail.",
        });
        terminal.resolve({ stopReason: "end_turn", userMessageId: "user" });
        await vi.waitFor(() => expect(completedTurn).toBeDefined());
        expect(completedTurn).toMatchObject({
          status: "completed",
          items: expect.arrayContaining([
            expect.objectContaining({
              type: "agentMessage",
              text: "Checking the repository.",
              phase: null,
            }),
            expect.objectContaining({
              type: "agentMessage",
              text: "Final architecture answer. More detail.",
              phase: "final_answer",
            }),
          ]),
        });
        expect(JSON.stringify(events)).not.toContain("child reply");
        const snapshot = await session.readSnapshot();
        if (!snapshot.ok) throw Error(snapshot.error.message);
        const last: HostThreadSnapshot["turns"][number] | undefined = snapshot.value.turns.at(-1);
        if (!last) throw Error("Missing native Turn");
        expect(projectHistoricalTurn({ turnId, cwd: process.cwd(), snapshot: last })).toMatchObject(
          {
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "agentMessage",
                text: "Final architecture answer. More detail.",
                phase: "final_answer",
              }),
            ]),
          },
        );
      } finally {
        await adapter.close();
        await collecting;
      }
    },
  );
});
