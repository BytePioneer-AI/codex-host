import type { SessionNotification } from "@agentclientprotocol/sdk";
import { nativeSessionRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorAdapter } from "../src/adapter.js";
import { cursorSnapshot } from "../src/projection.js";
import { CursorSubagents, cursorTaskHandle } from "../src/subagents.js";
import { CursorTransport } from "../src/transport.js";

const native = vi.hoisted(() => ({ turns: [] as Array<{ id: string; text: string }> }));
vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: () => structuredClone(native.turns),
}));
const parent = nativeSessionRefSchema.parse({
  harnessId: "cursor-cli",
  nativeSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  formatVersion: 1,
});
const input = { _toolName: "task", description: "Explore", prompt: "Read the files" };
const handle = cursorTaskHandle(1, 1, input);
const result = "detail ".repeat(400) + "FINAL_RESULT_MARKER";

function fixture(background = false) {
  native.turns = [
    { id: "earlier-turn", text: "earlier" },
    { id: "delegating-turn", text: "delegate" },
  ];
  const tasks = [
    {
      sessionId: parent.nativeSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "live-first-task",
        title: "First Task",
        rawInput: { ...input, prompt: "Another task" },
        status: "completed",
      },
    },
    {
      sessionId: parent.nativeSessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "live-second-task",
        title: "Second Task",
        rawInput: input,
        rawOutput: { isBackground: background },
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: result } }],
      },
    },
  ] satisfies SessionNotification[];
  const replay: SessionNotification[] = [
    ...native.turns.map((turn): SessionNotification => ({
      sessionId: parent.nativeSessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.text } },
    })),
    ...tasks.map((event, index): SessionNotification => ({
      sessionId: parent.nativeSessionId,
      update: { ...event.update, toolCallId: `replay-1-${index}` },
    })),
  ];
  vi.spyOn(CursorTransport.prototype, "open").mockImplementation(async function (
    this: CursorTransport,
  ) {
    this.replay = structuredClone(replay);
    return { configOptions: [] };
  });
  vi.spyOn(CursorTransport.prototype, "close").mockResolvedValue();
  return { tasks, replay, adapter: new CursorAdapter() };
}

afterEach(() => {
  native.turns = [];
  vi.restoreAllMocks();
});

describe("Cursor child history", () => {
  it.each([false, true])(
    "keeps the full Task result after reconnect while cards stay concise (background=%s)",
    async (background) => {
      const { adapter, tasks, replay } = fixture(background);
      try {
        const live = new CursorSubagents(hostTurnIdSchema.parse("host-turn"), () => {}, 1);
        for (const event of tasks) live.update(event);
        live.finish({ status: "succeeded" });
        const expected = live.snapshot(parent.nativeSessionId, handle);
        const restored = await adapter.subagents.readSnapshot({
          parent,
          nativeSubagentId: handle,
          cwd: process.cwd(),
        });
        expect(restored).toEqual({ ok: true, value: expected });
        expect(expected.turns[0]?.items[0]?.item).toMatchObject({ text: result });
        const card = cursorSnapshot(parent.nativeSessionId, native.turns, replay).turns[1]?.items[1]
          ?.item;
        expect(card).toMatchObject({
          type: "subagentDelegation",
          subagents: [{ status: background ? "interrupted" : "completed" }],
        });
        if (!background)
          expect(card).toMatchObject({ subagents: [{ resultSummary: result.slice(0, 2000) }] });
      } finally {
        await adapter.close();
      }
    },
  );
  it.each(["changed-prompt", "missing-task", "mismatched-history"])(
    "rejects an invalid child history read (%s)",
    async (scenario) => {
      const { adapter } = fixture();
      try {
        if (scenario === "mismatched-history")
          native.turns[0] = { id: "earlier-turn", text: "changed parent input" };
        const nativeSubagentId =
          scenario === "changed-prompt"
            ? cursorTaskHandle(1, 1, { ...input, prompt: "Changed task" })
            : scenario === "missing-task"
              ? cursorTaskHandle(2, 0, input)
              : handle;
        expect(
          await adapter.subagents.readSnapshot({ parent, nativeSubagentId, cwd: process.cwd() }),
        ).toMatchObject({ ok: false, error: { code: "protocolError" } });
      } finally {
        await adapter.close();
      }
    },
  );
});
