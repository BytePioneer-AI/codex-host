// Turn regressions adapted from liki-0814/codex-host commit 43eefce5 (LGPL-3.0).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CursorSession } from "../src/adapter.js";
import { CursorTransport } from "../src/transport.js";

const native = vi.hoisted(() => ({ turns: [] as Array<{ id: string; text: string }> }));
vi.mock("../src/native-history.js", () => ({
  readCursorNativeTurns: () => structuredClone(native.turns),
  readCursorNativeHistory: () => ({
    revision: JSON.stringify(native.turns),
    turns: structuredClone(native.turns),
  }),
}));
const error = "\n\nError: RetriableError: WritableIterable is closed";
const sessions: CursorSession[] = [];
const drains: Promise<void>[] = [];
function fixture(unattended = false) {
  const transport = new CursorTransport({
    cwd: process.cwd(),
    environment: {},
    ...(unattended ? { executionPolicy: "unattended-full-access" as const } : {}),
  });
  transport.sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  vi.spyOn(transport, "close").mockResolvedValue();
  vi.spyOn(transport, "cancel").mockResolvedValue();
  const session = new CursorSession(
    transport,
    {
      sessionId: transport.sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "model",
          options: [{ value: "model", name: "Model" }],
        },
      ],
    },
    () => {},
  );
  const output: HarnessOutput[] = [];
  sessions.push(session);
  drains.push(
    (async () => {
      for await (const event of session.outputs) output.push(event);
    })(),
  );
  const message = (text: string) => ({
    sessionId: transport.sessionId,
    update: {
      sessionUpdate: "agent_message_chunk" as const,
      content: { type: "text" as const, text },
    },
  });
  return { transport, session, output, message };
}
function start(id = "turn-one") {
  return {
    type: "turn.start" as const,
    turnId: hostTurnIdSchema.parse(id),
    input: [{ type: "text" as const, text: "hello" }],
  };
}
async function terminal(f: ReturnType<typeof fixture>, id = "turn-one") {
  await vi.waitFor(() =>
    expect(
      f.output.some(
        (item) =>
          item.kind === "event" && item.event.type === "turn.completed" && item.event.turnId === id,
      ),
    ).toBe(true),
  );
  return f.output.find(
    (item) =>
      item.kind === "event" && item.event.type === "turn.completed" && item.event.turnId === id,
  );
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(drains.splice(0));
  vi.restoreAllMocks();
  native.turns = [];
});

describe("Cursor streamed teardown lifecycle", () => {
  it("retains a completed native answer and its verified turn identity", async () => {
    const f = fixture();
    vi.spyOn(f.transport, "prompt").mockImplementation(async (text, callbacks) => {
      callbacks.update(f.message("PONG"));
      callbacks.update(f.message(error));
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    });
    expect(await f.session.execute(start())).toMatchObject({ ok: true });
    expect(await terminal(f)).toMatchObject({
      event: {
        outcome: { status: "succeeded" },
        nativeTurnRef: { nativeTurnKey: native.turns[0]?.id },
      },
    });
    expect(JSON.stringify(f.output)).not.toContain("WritableIterable");
  });

  it.each([false, true])(
    "fails retryably without automatic replay (persisted=%s), then accepts a new turn",
    async (persisted) => {
      const f = fixture();
      const prompt = vi
        .spyOn(f.transport, "prompt")
        .mockImplementationOnce(async (text, callbacks) => {
          callbacks.update(f.message(error));
          if (persisted) native.turns.push({ id: randomUUID(), text });
          return { stopReason: "end_turn" };
        });
      await f.session.execute(start());
      const failed = await terminal(f);
      expect(failed).toMatchObject({
        event: { outcome: { status: "failed", error: { code: "nativeFailure", retryable: true } } },
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(
        f.output.some((item) => item.kind === "event" && item.event.type === "session.faulted"),
      ).toBe(false);
      if (!persisted) expect(failed).not.toHaveProperty("event.nativeTurnRef");
      prompt.mockImplementationOnce(async (text, callbacks) => {
        callbacks.update(f.message("recovered"));
        native.turns.push({ id: randomUUID(), text });
        return { stopReason: "end_turn" };
      });
      expect(await f.session.execute(start("turn-two"))).toMatchObject({ ok: true });
      expect(await terminal(f, "turn-two")).toMatchObject({
        event: { outcome: { status: "succeeded" } },
      });
    },
  );

  it("does not re-execute a native tool even when no native turn was persisted", async () => {
    const f = fixture();
    const prompt = vi.spyOn(f.transport, "prompt").mockImplementation(async (_text, callbacks) => {
      callbacks.update({
        sessionId: f.transport.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "write",
          title: "Write",
          status: "completed",
        },
      });
      callbacks.update(f.message(error));
      return { stopReason: "end_turn" };
    });
    await f.session.execute(start());
    expect(await terminal(f)).toMatchObject({ event: { outcome: { status: "failed" } } });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("preserves explicit cancellation over a streamed teardown", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<PromptResponse>();
    const prompt = vi.spyOn(f.transport, "prompt").mockImplementation(async (_text, callbacks) => {
      callbacks.update(f.message(error));
      return gate.promise;
    });
    await f.session.execute(start());
    await f.session.execute({ type: "turn.cancel", turnId: start().turnId });
    gate.resolve({ stopReason: "cancelled" });
    expect(await terminal(f)).toMatchObject({ event: { outcome: { status: "cancelled" } } });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not turn an unattended approval refusal into success", async () => {
    const f = fixture(true);
    vi.spyOn(f.transport, "prompt").mockImplementation(async (text, callbacks) => {
      await callbacks.permission({
        sessionId: f.transport.sessionId,
        toolCall: { toolCallId: "shell", title: "Shell" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      callbacks.update(f.message("PONG"));
      callbacks.update(f.message(error));
      native.turns.push({ id: randomUUID(), text });
      return { stopReason: "end_turn" };
    });
    await f.session.execute(start());
    expect(await terminal(f)).toMatchObject({
      event: {
        outcome: {
          status: "failed",
          error: {
            message: "Cursor requested approval during unattended full access",
            retryable: false,
          },
        },
      },
    });
    expect(f.transport.cancel).toHaveBeenCalledOnce();
  });

  it("still rejects success without verified native turn identity", async () => {
    const f = fixture();
    vi.spyOn(f.transport, "prompt").mockImplementation(async (_text, callbacks) => {
      callbacks.update(f.message("PONG"));
      callbacks.update(f.message(error));
      return { stopReason: "end_turn" };
    });
    await f.session.execute(start());
    expect(await terminal(f)).toMatchObject({ event: { outcome: { status: "failed" } } });
  });
});
