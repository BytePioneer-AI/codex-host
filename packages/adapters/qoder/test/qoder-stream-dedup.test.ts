import { describe, expect, it } from "vitest";
import { HarnessOutputChannel, type HostEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { QoderSession } from "../src/qoder-sdk-transport.js";
import type { SDKMessage } from "../src/qoder-sdk-types.js";
import type { QoderVariant } from "../src/qoder-runtime.js";

async function projectTurns(turns: unknown[][], variant: QoderVariant) {
  const messages = new HarnessOutputChannel<SDKMessage>();
  const session = new QoderSession({
    variant,
    sessionId: "native-session",
    cwd: "/work",
    queryFactory: () => ({
      [Symbol.asyncIterator]: () => messages.outputs[Symbol.asyncIterator](),
      interrupt: async () => {},
      close: async () => messages.end(),
    }),
  });
  const events: HostEvent[] = [];
  const outputs = session.outputs[Symbol.asyncIterator]();
  try {
    for (const [index, input] of turns.entries()) {
      const turnId = hostTurnIdSchema.parse(`turn-${index}`);
      const projector = new CodexTurnProjector({
        threadId: "thread",
        turnId,
        cwd: "/work",
        startedAtMs: 1,
      });
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "hello" }],
        }),
      ).toMatchObject({ ok: true });
      for (const message of input) messages.emit(message as SDKMessage);
      messages.emit({ type: "result", subtype: "success" } as SDKMessage);
      while (true) {
        const next = await outputs.next();
        if (next.done) throw Error("Session ended before Turn completion");
        if (next.value.kind !== "event") continue;
        const event = next.value.event;
        events.push(event);
        if ("turnId" in event && event.type !== "turn.autonomous.started") projector.project(event);
        if (event.type === "turn.completed") break;
      }
    }
    return events;
  } finally {
    await session.close();
  }
}

const tool = (id: string) => ({ type: "tool_use", id, name: "Read", input: { path: id } });
const assistant = (uuid: string, content: unknown[]) => ({
  type: "assistant",
  uuid,
  parent_tool_use_id: null,
  message: { content },
});
const result = (id: string, content = "root result") => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});
const stream = (delta: unknown) => ({ type: "stream_event", event: { delta } });
const starts = (events: HostEvent[]) =>
  events.flatMap((event) => (event.type === "item.started" ? [event.item] : []));

describe.each<QoderVariant>(["global", "cn"])("Qoder %s live stream identity", (variant) => {
  it("starts each named tool once per Turn across cumulative snapshots and completed-tool replays", async () => {
    const events = await projectTurns(
      [
        [
          assistant("first", [tool("one")]),
          assistant("first", [tool("one"), tool("two")]),
          result("one"),
          assistant("reconnect", [tool("one"), tool("two")]),
          result("one", "duplicate result"),
          result("two"),
        ],
        [assistant("next-turn", [tool("one")]), result("one")],
      ],
      variant,
    );
    expect(starts(events).map((item) => item.itemId)).toEqual(["one", "two", "one"]);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(3);
  });

  it.each([undefined, "", " "])("keeps anonymous tool blocks distinct (id: %j)", async (id) => {
    const events = await projectTurns(
      [
        [
          assistant("anonymous-one", [{ ...tool("ignored"), id }]),
          result(id ?? "unmatched"),
          assistant("anonymous-two", [{ ...tool("ignored"), id }]),
          result(id ?? "unmatched"),
        ],
      ],
      variant,
    );
    expect(starts(events)).toHaveLength(2);
    expect(new Set(starts(events).map((item) => item.itemId)).size).toBe(2);
  });

  it("does not end a new streaming message at a repeated Tool block", async () => {
    const events = await projectTurns(
      [
        [
          assistant("tool", [tool("one")]),
          result("one"),
          stream({ text: "After" }),
          assistant("tool", [tool("one")]),
          stream({ text: " tool" }),
          assistant("final", [{ type: "text", text: "After tool" }]),
        ],
      ],
      variant,
    );
    expect(starts(events).map((item) => item.type)).toEqual(["toolExecution", "agentMessage"]);
    expect(events.filter((event) => event.type === "item.completed")).toMatchObject([
      { snapshot: { item: { type: "toolExecution" } } },
      { snapshot: { item: { type: "agentMessage", text: "After tool" } } },
    ]);
  });

  it("does not repeat text or thinking snapshots after their streaming Items complete", async () => {
    const content = [
      { type: "thinking", thinking: "Analysis" },
      { type: "text", text: "Checking" },
      tool("one"),
    ];
    const events = await projectTurns(
      [
        [
          stream({ thinking: "Anal" }),
          stream({ text: "Check" }),
          assistant("reply", content),
          result("one"),
          assistant("reply", [...content, tool("two")]),
          result("two"),
          assistant("final", [{ type: "text", text: "Checking" }]),
        ],
      ],
      variant,
    );
    expect(starts(events).map((item) => item.type)).toEqual([
      "reasoning",
      "agentMessage",
      "toolExecution",
      "toolExecution",
      "agentMessage",
    ]);
    expect(events.filter((event) => event.type === "item.completed")).toHaveLength(5);
  });

  it.each(["child-tool", ""])(
    "ignores non-root assistant, stream and user messages (parent: %j)",
    async (parent) => {
      const events = await projectTurns(
        [
          [
            {
              type: "assistant",
              uuid: "root",
              parent_tool_use_id: null,
              message: {
                content: [tool("root-tool")],
                usage: { input_tokens: 10, output_tokens: 2 },
              },
            },
            { ...stream({ text: "child text" }), parent_tool_use_id: parent },
            { ...stream({ thinking: "child thinking" }), parent_tool_use_id: parent },
            {
              type: "assistant",
              uuid: "child",
              parent_tool_use_id: parent,
              message: {
                content: [tool("root-tool"), { type: "text", text: "child snapshot" }],
                usage: { input_tokens: 999, output_tokens: 999 },
              },
            },
            { ...result("root-tool", "child result"), parent_tool_use_id: parent },
            result("root-tool"),
            assistant("root-final", [{ type: "text", text: "Done" }]),
          ],
        ],
        variant,
      );
      expect(starts(events).map((item) => item.type)).toEqual(["toolExecution", "agentMessage"]);
      expect(events.find((event) => event.type === "item.completed")).toMatchObject({
        snapshot: { item: { output: { content: [{ text: "root result" }] } } },
      });
      expect(events.findLast((event) => event.type === "session.usage.changed")).toMatchObject({
        usage: { inputTokens: 10, outputTokens: 2 },
      });
      expect(events.at(-1)).toMatchObject({
        type: "turn.completed",
        outcome: { checkpoint: { checkpointId: "root-final" } },
      });
      expect(JSON.stringify(events)).not.toContain("child");
    },
  );
});
