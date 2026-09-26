import { describe, expect, it } from "vitest";
import { projectHistoricalTurn } from "@codexhost/protocol-core";

import { projectModernHistory } from "../../src/modern/history.js";
import type { ModernJournalEvent } from "../../src/modern/journal.js";
import {
  DEEPSEEK_V012_PROFILE,
  DEEPSEEK_V015_PROFILE,
  DEEPSEEK_V017_PROFILE,
  type DeepSeekModernProfile,
} from "../../src/profiles/profile.js";

const SESSION_ID = "ptc-session";
const RUN_CODE_ARGUMENTS = JSON.stringify({
  code: "const date = await tools.pwsh({ command: 'Get-Date' });\nconsole.log(date);",
  description: "Read the current date",
});

type Format = "V0" | "V3" | "V4";
type Push = (type: string, data: Record<string, unknown>) => void;

const FORMATS: Record<Format, { profile: DeepSeekModernProfile; dispatch: string }> = {
  V0: { profile: DEEPSEEK_V012_PROFILE, dispatch: "tool/code-dispatch" },
  V3: { profile: DEEPSEEK_V015_PROFILE, dispatch: "tool/ptc-dispatch" },
  V4: { profile: DEEPSEEK_V017_PROFILE, dispatch: "tool/ptc-dispatch" },
};

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  surface: boolean,
): ModernJournalEvent {
  return {
    type,
    seq,
    time: 1_000 + seq * 10,
    data: data as never,
    ...(surface ? { surfaceOp: "append" as const } : {}),
  };
}

function subCall(n: number, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    rootCallId: "call-1",
    parentCallId: "call-1",
    subCallId: `call-1:ptc:${n}`,
    name,
    arguments: args,
  };
}

function settled(
  call: Record<string, unknown>,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...call, isError: false, content: [{ type: "text", text }], ...extra };
}

/** One native PTC Turn: `run_code` wraps the dispatch events written by `body`. */
function ptcTurn(
  format: Format,
  body: (push: Push, dispatch: string) => void,
  ending: "completed" | "aborted" = "completed",
): ModernJournalEvent[] {
  const events: ModernJournalEvent[] = [];
  const surface = new Set(["user/message", "developer/message", "assistant/message"]);
  const push: Push = (type, data) => {
    events.push(event(events.length, type, data, surface.has(type) || type === "tool/result"));
  };
  push("turn/start", { turn: 1 });
  push("step/start", { turn: 1, step: 1 });
  if (format === "V4") {
    push("request/header", {
      reason: "initial",
      header: {
        config: { provider: "deepseek", model: "deepseek-v4" },
        tools: [{ name: "run_code", description: "Run a program", parameters: {} }],
      },
    });
  }
  push("user/message", {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text: "What time is it?" }],
    source: { kind: "user" },
  });
  if (format === "V4") {
    push("developer/message", {
      turn: 1,
      step: 1,
      headerSeq: 2,
      message: {
        id: "developer-1",
        role: "developer",
        source: { kind: "tool-registry" },
        content: [{ type: "tool-addition", toolName: "run_code" }],
      },
    });
  }
  push("assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [
        { type: "tool-call", id: "call-1", name: "run_code", arguments: RUN_CODE_ARGUMENTS },
      ],
      source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
    },
    ...(format === "V0" ? {} : { stream: [] }),
  });
  push("tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "run_code",
    arguments: RUN_CODE_ARGUMENTS,
  });
  body(push, FORMATS[format].dispatch);
  if (ending === "completed") {
    push("tool/result", {
      turn: 1,
      step: 1,
      message:
        format !== "V4"
          ? {
              id: "result-1",
              role: "user",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-1",
                  content: [{ type: "text", text: "2026-09-27" }],
                },
              ],
              source: { kind: "tool", callId: "call-1" },
            }
          : {
              id: "result-1",
              role: "tool",
              toolCallId: "call-1",
              isError: false,
              content: [{ type: "text", text: "2026-09-27" }],
              source: { kind: "tool", callId: "call-1" },
            },
    });
  }
  push("step/end", { turn: 1, step: 1 });
  push("turn/end", {
    turn: 1,
    reason:
      ending === "completed"
        ? { kind: "completed" }
        : { kind: "aborted", reason: { kind: "user" } },
  });
  return events;
}

function project(format: Format, events: readonly ModernJournalEvent[]) {
  return projectModernHistory({
    sessionId: SESSION_ID,
    events,
    profile: FORMATS[format].profile,
  });
}

describe("DeepSeek Harness PTC code dispatch projection", () => {
  it.each(["V0", "V3", "V4"] as const)(
    "projects every %s sub-call as its own Tool Item in place of run_code",
    (format) => {
      const date = subCall(1, "pwsh", { command: "Get-Date", description: "Read the date" });
      const read = subCall(2, "read", { path: "src/missing.ts" });
      const events = ptcTurn(format, (push, dispatch) => {
        push(`${dispatch}-start`, date);
        push(dispatch, settled(date, "2026-09-27\r\n"));
        push(`${dispatch}-start`, read);
        push(dispatch, { ...settled(read, "Error: file not found"), isError: true });
      });
      const startSeq = events.findIndex(({ type }) => type.endsWith("-dispatch-start"));

      const turn = project(format, events).snapshot.turns[0];
      expect(turn?.items).toEqual([
        {
          item: {
            type: "toolExecution",
            itemId: `dsh-modern:${SESSION_ID}:event:${startSeq}:tool`,
            toolName: "pwsh",
            arguments: { command: "Get-Date", description: "Read the date" },
            output: { content: [{ type: "text", text: "2026-09-27\r\n" }] },
          },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "toolExecution",
            itemId: `dsh-modern:${SESSION_ID}:event:${startSeq + 2}:tool`,
            toolName: "read",
            arguments: { path: "src/missing.ts" },
            output: { content: [{ type: "text", text: "Error: file not found" }] },
          },
          outcome: {
            status: "failed",
            error: expect.objectContaining({ message: "DeepSeek Harness Tool 'read' failed" }),
          },
        },
      ]);

      // Desktop shows each sub-call through the same carrier as a direct call.
      const wire = projectHistoricalTurn({
        turnId: "turn-1" as never,
        cwd: "/fixture",
        snapshot: turn as never,
      });
      expect(wire.items).not.toContainEqual(expect.objectContaining({ tool: "run_code" }));
      expect(wire.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "commandExecution",
            command: "Get-Date",
            aggregatedOutput: "2026-09-27\r\n",
            status: "completed",
          }),
          expect.objectContaining({
            type: "commandExecution",
            command: "read src/missing.ts",
            status: "failed",
          }),
        ]),
      );
    },
  );

  it("projects no Item for the run_code program itself", () => {
    for (const format of ["V0", "V3", "V4"] as const) {
      expect(
        project(
          format,
          ptcTurn(format, () => undefined),
        ).snapshot.turns[0]?.items,
      ).toEqual([]);
    }

    const forkRepair = (name: string): ModernJournalEvent[] => [
      event(0, "turn/start", { turn: 1 }, false),
      event(1, "step/start", { turn: 1, step: 1 }, false),
      event(
        2,
        "assistant/message",
        {
          turn: 1,
          step: 1,
          message: {
            id: "assistant-fork",
            role: "assistant",
            source: { kind: "model", provider: "deepseek", model: "deepseek-v4" },
            content: [{ type: "tool-call", id: "fork-call", name, arguments: "{}" }],
          },
          stream: [],
        },
        true,
      ),
      event(
        3,
        "tool/result",
        {
          turn: 1,
          step: 1,
          error: { name: "ToolNotStartedError", code: "TOOL_NOT_STARTED" },
          message: {
            id: "forked-tool-result-fork-call-3",
            role: "tool",
            source: { kind: "tool", callId: "fork-call" },
            toolCallId: "fork-call",
            isError: true,
            content: [{ type: "text", text: "Not started before the fork point." }],
          },
        },
        true,
      ),
      event(4, "step/end", { turn: 1, step: 1 }, false),
      event(5, "turn/end", { turn: 1, reason: { kind: "forked" } }, false),
    ];
    // A Fork that never started run_code shows nothing, unlike an ordinary Tool.
    expect(project("V4", forkRepair("run_code")).snapshot.turns[0]?.items).toEqual([]);
    expect(project("V4", forkRepair("read")).snapshot.turns[0]?.items).toMatchObject([
      { item: { toolName: "read" }, outcome: { status: "failed" } },
    ]);
  });

  it("keeps PTC file edits in the Turn's file changes", () => {
    const edit = subCall(1, "edit", {
      file_path: "src/a.ts",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    });
    const turn = project(
      "V4",
      ptcTurn("V4", (push, dispatch) => {
        push(`${dispatch}-start`, edit);
        push(dispatch, settled(edit, "<path>src/a.ts</path>"));
      }),
    ).snapshot.turns[0];
    const wire = projectHistoricalTurn({
      turnId: "turn-1" as never,
      cwd: "/fixture",
      snapshot: turn as never,
    });
    expect(wire.items).toContainEqual(
      expect.objectContaining({
        type: "fileChange",
        changes: [expect.objectContaining({ path: "src/a.ts" })],
      }),
    );
  });

  it("bounds sub-call output with the Tool output limit", () => {
    const date = subCall(1, "pwsh", { command: "Get-Date" });
    const events = ptcTurn("V4", (push, dispatch) => {
      push(`${dispatch}-start`, date);
      push(dispatch, settled(date, "abcdef"));
    });
    const projected = projectModernHistory({
      sessionId: SESSION_ID,
      events,
      profile: DEEPSEEK_V017_PROFILE,
      toolOutputLimit: 3,
    });
    expect(projected.snapshot.turns[0]?.items[0]?.item).toMatchObject({
      toolName: "pwsh",
      output: { content: [{ type: "text", text: "abc" }], truncated: true },
    });
  });

  it("closes an unsettled sub-call with the Turn and shows a settle without its start", () => {
    const pending = subCall(1, "pwsh", { command: "Start-Sleep 60" });
    const aborted = project(
      "V3",
      ptcTurn("V3", (push, dispatch) => push(`${dispatch}-start`, pending), "aborted"),
    ).snapshot.turns[0];
    expect(aborted?.items.map(({ item, outcome }) => [item.type, outcome?.status])).toEqual([
      ["toolExecution", "cancelled"],
    ]);

    const orphan = subCall(2, "grep", { pattern: "TODO" });
    const settledOnly = project(
      "V3",
      ptcTurn("V3", (push, dispatch) => push(dispatch, settled(orphan, "a.ts:1"))),
    ).snapshot.turns[0];
    expect(settledOnly?.items[0]).toMatchObject({
      item: { toolName: "grep", output: { content: [{ type: "text", text: "a.ts:1" }] } },
      outcome: { status: "succeeded" },
    });
  });

  it("validates a sub-call failure identity with the tool/result rules of each format", () => {
    const cancelled = subCall(1, "pwsh", { command: "Start-Sleep 60" });
    const withError = (format: Format, error: unknown) =>
      ptcTurn(format, (push, dispatch) => {
        push(`${dispatch}-start`, cancelled);
        push(dispatch, {
          ...settled(cancelled, "Error: tool call aborted"),
          isError: true,
          error,
        });
      });
    const abort = { name: "AbortError", code: "TOOL_ABORTED" };
    const incompatible = "Modern history known event has an incompatible schema";

    for (const format of ["V3", "V4"] as const) {
      expect(project(format, withError(format, abort)).snapshot.turns[0]?.items[0]).toMatchObject({
        item: { toolName: "pwsh" },
        outcome: { status: "failed" },
      });
      expect(() => project(format, withError(format, { name: "AbortError" }))).toThrow(
        incompatible,
      );
    }
    const detailed = { ...abort, reason: "user cancelled" };
    expect(() => project("V4", withError("V4", detailed))).not.toThrow();
    expect(() => project("V3", withError("V3", detailed))).toThrow(incompatible);
    expect(() => project("V0", withError("V0", abort))).toThrow(incompatible);
  });
});
