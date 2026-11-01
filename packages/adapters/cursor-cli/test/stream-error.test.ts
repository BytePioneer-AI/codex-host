// Adapted from liki-0814/codex-host commit 43eefce5 (LGPL-3.0).
import { describe, expect, it } from "vitest";
import type { HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CursorTurnOutput, cursorSnapshot } from "../src/projection.js";
import {
  holdCursorWritableIterablePrefix,
  isCursorWritableIterableClosed,
  takeCursorWritableIterableClosed,
} from "../src/stream-error.js";
import { cursorError } from "../src/adapter.js";

const error = "Error: RetriableError: WritableIterable is closed";
function output() {
  const events: HostEvent[] = [];
  return {
    events,
    turn: new CursorTurnOutput(hostTurnIdSchema.parse("turn"), (event) => events.push(event)),
  };
}
function message(text: string) {
  return {
    sessionId: "session",
    update: {
      sessionUpdate: "agent_message_chunk" as const,
      content: { type: "text" as const, text },
    },
  };
}
function text(events: HostEvent[]) {
  return events
    .flatMap((event) =>
      event.type === "item.updated" && event.update.type === "text.append"
        ? [event.update.text]
        : [],
    )
    .join("");
}

describe("Cursor WritableIterable stream error", () => {
  it("classifies the native teardown as retryable instead of process exit", () => {
    expect(isCursorWritableIterableClosed(error)).toBe(true);
    expect(cursorError(new Error(error))).toEqual({
      code: "nativeFailure",
      message: "Cursor stream closed (WritableIterable)",
      retryable: true,
    });
  });

  it("splits a trailing closed suffix from a completed answer", () => {
    expect(takeCursorWritableIterableClosed(`PONG\n\n${error}`)).toEqual({
      visible: "PONG",
      closed: true,
    });
    expect(holdCursorWritableIterablePrefix("PONG\n\nErr")).toEqual({
      emit: "PONG",
      hold: "\n\nErr",
    });
  });

  it.each([error, "Error: T: WritableIterable is closed", "Error: WritableIterable is closed"])(
    "handles every chunk boundary for %s",
    (suffix) => {
      const full = `PONG\n\n${suffix}`;
      for (let split = 0; split <= full.length; split += 1) {
        const f = output();
        f.turn.update(message(full.slice(0, split)));
        f.turn.update(message(full.slice(split)));
        expect(f.turn.sawWritableIterableClosed()).toBe(true);
        expect(f.turn.hasVisibleAssistantText()).toBe(true);
        f.turn.finish({ status: "succeeded" });
        expect(text(f.events)).toBe("PONG");
        expect(f.turn.hasVisibleAssistantText()).toBe(true);
      }
    },
  );

  it("does not create an empty message for an error-only response", () => {
    const f = output();
    for (const char of error) f.turn.update(message(char));
    expect(f.turn.sawWritableIterableClosed()).toBe(true);
    expect(f.turn.hasVisibleAssistantText()).toBe(false);
    f.turn.finish({ status: "failed", error: cursorError(new Error(error)) });
    expect(f.events.filter((event) => event.type === "item.started")).toEqual([]);
  });

  it.each([
    ["ordinary ", "Error"],
    ["Example: ", "Error: Retriable", "Error: WritableIterable is closed"],
    [error, " is only an example"],
    ["An unfinished\n\nErr"],
    ["Other error: WritableIterable is closed"],
  ])("preserves ordinary text chunks %j", (...chunks) => {
    const f = output();
    for (const chunk of chunks) f.turn.update(message(chunk));
    expect(f.turn.sawWritableIterableClosed()).toBe(false);
    f.turn.finish({ status: "succeeded" });
    expect(text(f.events)).toBe(chunks.join(""));
  });

  it("remembers completed assistant text across tool and reasoning boundaries", () => {
    const f = output();
    f.turn.update(message("PONG"));
    f.turn.update({
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool",
        title: "Tool",
        status: "completed",
      },
    });
    f.turn.update({
      sessionId: "session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } },
    });
    f.turn.update(message(error));
    expect(f.turn.hasVisibleAssistantText()).toBe(true);
    f.turn.finish({ status: "succeeded" });
    expect(text(f.events)).toBe("PONGthought");
  });

  it("cleans replay without inventing a successful historical outcome", () => {
    const snapshot = cursorSnapshot(
      "session",
      [{ id: "native-turn", text: "hello" }],
      [
        {
          sessionId: "session",
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
        },
        message(`PONG\n\n${error}`),
      ],
    );
    expect(snapshot.turns[0]?.items).toMatchObject([
      { item: { type: "agentMessage", text: "PONG" } },
    ]);
    expect(snapshot.turns[0]?.outcome.status).toBe("unknown");
  });

  it("flushes an ordinary held prefix before reasoning", () => {
    const f = output();
    f.turn.update(message("Error"));
    f.turn.update({
      sessionId: "session",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thought" } },
    });
    f.turn.finish({ status: "succeeded" });
    expect(text(f.events)).toBe("Errorthought");
  });
});
