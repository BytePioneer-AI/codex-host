import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostEvent, HostTurnSnapshot } from "@codexhost/harness-adapter";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";
import type { KimiTransportEvent } from "../src/acp-transport.js";
import type { KimiAcpTransportLike } from "../src/kimi-adapter.js";
import { KimiSession } from "../src/kimi-session.js";
import { createKimiNativeTurnRef } from "../src/history.js";

async function replay(events: KimiTransportEvent[], terminal = "succeeded") {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "kimi-answer-"));
  const native: HostTurnSnapshot[] = [];
  const turnId = hostTurnIdSchema.parse("kimi-answer");
  const transport: KimiAcpTransportLike = {
    sessionId: "native",
    isClosed: false,
    setActivePromptHandler() {},
    setSessionEventHandler() {},
    async inspect() {
      return { initialize: { protocolVersion: 1 }, authReady: true };
    },
    async openSession() {
      return { sessionId: "native" };
    },
    async setConfigOption() {
      return [];
    },
    async prompt(text, handler) {
      for (const event of events) handler.onEvent(event);
      if (terminal === "failed") throw new Error("Native prompt failed");
      if (terminal !== "missing-native")
        native.push({
          nativeTurnRef: createKimiNativeTurnRef("native", 0),
          input: [{ type: "text", text }],
          items: [],
          outcome:
            terminal === "cancelled"
              ? { status: "cancelled" }
              : terminal === "native-failed"
                ? {
                    status: "failed",
                    error: { code: "nativeFailure", message: "Native failure", retryable: false },
                  }
                : { status: "succeeded" },
        });
      return { stopReason: terminal === "cancelled" ? "cancelled" : "end_turn" };
    },
    async cancel() {},
    async close() {},
  };
  const session = new KimiSession({
    transport,
    sessionId: "native",
    cwd: homeDirectory,
    homeDirectory,
    initialState: {},
    nativeTurnFlushTimeoutMs: 0,
    readNativeSnapshot: async () => ({ turns: [...native] }),
  });
  const projector = new CodexTurnProjector({
    threadId: "thread",
    turnId,
    cwd: homeDirectory,
    startedAtMs: 1_000,
  });
  const emitted: HostEvent[] = [];
  try {
    expect(
      await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "Question" }],
      }),
    ).toMatchObject({ ok: true });
    for await (const output of session.outputs) {
      if (output.kind !== "event") continue;
      const event = output.event;
      emitted.push(event);
      if (!("turnId" in event) || event.type === "turn.autonomous.started") continue;
      const result = projector.project(event);
      if (result.completedTurn) return { events: emitted, turn: result.completedTurn };
    }
    throw new Error("Missing completed turn");
  } finally {
    await session.close();
    await rm(homeDirectory, { recursive: true, force: true });
  }
}
const text = (text: string): KimiTransportEvent => ({ type: "agent.text", text });
const tool: KimiTransportEvent = {
  type: "tool.call",
  toolCallId: "read",
  name: "ReadFile",
  args: { path: "README.md" },
};
const done: KimiTransportEvent = {
  type: "tool.update",
  toolCallId: "read",
  status: "completed",
  rawOutput: "contents",
};
function messages(events: HostEvent[]) {
  return events.flatMap((event) =>
    event.type === "item.completed" && event.snapshot.item.type === "agentMessage"
      ? [event.snapshot]
      : [],
  );
}

describe("Kimi answer boundaries", () => {
  it.each(["completed", "failed"])(
    "keeps the entire final answer across existing-tool updates and repeated %s notifications",
    async (status) => {
      const completion: KimiTransportEvent = { ...done, status };
      const result = await replay([
        text("Checking."),
        tool,
        text("Final "),
        { type: "tool.update", toolCallId: "read", status: "in_progress" },
        tool,
        text("answer"),
        completion,
        completion,
        tool,
        text("."),
      ]);
      expect(messages(result.events)).toMatchObject([
        { item: { text: "Checking.", phase: "commentary" } },
        { item: { text: "Final answer.", phase: "final_answer" } },
      ]);
      expect(result.turn).toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Final answer.", phase: "final_answer" }),
        ]),
      });
      expect(
        result.events.filter(
          (e) => e.type === "item.completed" && e.snapshot.item.type === "toolExecution",
        ),
      ).toHaveLength(1);
    },
  );

  it("does not turn a whole answer into commentary on a late tool completion", async () => {
    const result = await replay([tool, text("Complete final answer."), done]);
    expect(result.turn).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ text: "Complete final answer.", phase: "final_answer" }),
      ]),
    });
  });

  it("recognizes a new tool first seen in an update as a reply boundary", async () => {
    const result = await replay([
      text("Checking."),
      { ...done, name: "ReadFile" },
      text("Final answer."),
    ]);
    expect(messages(result.events)).toMatchObject([
      { item: { text: "Checking.", phase: "commentary" } },
      { item: { text: "Final answer.", phase: "final_answer" } },
    ]);
  });

  it("keeps reasoning together across old tool updates and completes it before the answer", async () => {
    const result = await replay([
      tool,
      { type: "agent.thought", text: "Thinking " },
      done,
      done,
      { type: "agent.thought", text: "more." },
      text("Final answer."),
    ]);
    const thoughts = result.events.filter(
      (e) => e.type === "item.completed" && e.snapshot.item.type === "reasoning",
    );
    expect(thoughts).toMatchObject([{ snapshot: { item: { text: "Thinking more." } } }]);
  });

  it.each(["failed", "cancelled", "native-failed", "missing-native"])(
    "does not promote partial text to final_answer when the turn is %s",
    async (terminal) => {
      const result = await replay([tool, text("Partial "), done, text("answer.")], terminal);
      expect(result.turn).toMatchObject({
        status: terminal === "cancelled" ? "interrupted" : "failed",
        items: expect.arrayContaining([
          expect.objectContaining({ text: "Partial answer.", phase: "commentary" }),
        ]),
      });
      expect(messages(result.events)).toMatchObject([
        {
          item: { text: "Partial answer.", phase: "commentary" },
          outcome: { status: terminal === "cancelled" ? "cancelled" : "failed" },
        },
      ]);
    },
  );
});
