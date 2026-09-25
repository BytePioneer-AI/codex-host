import { describe, expect, it } from "vitest";

import type { HarnessOutput, HostItem, HostItemSnapshot } from "@codexhost/harness-adapter";
import type { HostTurnId } from "@codexhost/shared-contracts";
import type { DiagnosticLogFields, DiagnosticLogLevel } from "../src/logging/diagnostic-log.js";
import { ThreadEventLog } from "../src/logging/thread-event-log.js";

const TURN = "turn-1" as HostTurnId;

interface Record_ {
  level: DiagnosticLogLevel;
  event: string;
  fields: DiagnosticLogFields;
}

function collector(): { records: Record_[]; log: ThreadEventLog } {
  const records: Record_[] = [];
  let clock = 1_000;
  const log = new ThreadEventLog(
    (level, event, fields = {}) => records.push({ level, event, fields }),
    () => (clock += 500),
  );
  return { records, log };
}

function itemSnapshot(
  item: HostItem,
  status: "succeeded" | "failed" = "succeeded",
): HostItemSnapshot {
  return status === "succeeded"
    ? { item, outcome: { status: "succeeded" } }
    : {
        item,
        outcome: {
          status: "failed",
          error: { code: "nativeFailure", message: "native failed", retryable: false },
        },
      };
}

describe("Thread event log", () => {
  it("records a Turn as bounded metadata without streaming deltas", () => {
    const { records, log } = collector();
    log.output({ kind: "event", event: { type: "turn.started", turnId: TURN } });
    log.output({
      kind: "event",
      event: {
        type: "item.started",
        turnId: TURN,
        item: { type: "agentMessage", itemId: "item-1" as never, text: "" },
      },
    });
    for (const text of ["Hello ", "world"]) {
      log.output({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: TURN,
          itemId: "item-1" as never,
          update: { type: "text.append", text },
        },
      });
    }
    log.output({
      kind: "event",
      event: {
        type: "item.completed",
        turnId: TURN,
        snapshot: itemSnapshot({
          type: "agentMessage",
          itemId: "item-1" as never,
          text: "Hello world",
          phase: "final_answer",
        }),
      },
    });
    log.output({
      kind: "event",
      event: { type: "turn.completed", turnId: TURN, outcome: { status: "succeeded" } },
    });

    expect(records.map(({ event: name }) => name)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
    const completedItem = records[2];
    expect(completedItem?.fields).toMatchObject({
      itemType: "agentMessage",
      status: "succeeded",
      updates: 2,
      appendedChars: 11,
      textChars: 11,
      phase: "final_answer",
    });
    expect(records[3]?.fields).toMatchObject({
      status: "succeeded",
      items: { agentMessage: 1 },
    });
  });

  it("never records user, model, tool, command, or file content", () => {
    const { records, log } = collector();
    const secret = "SENTINEL_CONTENT_MUST_NOT_APPEAR";
    const outputs: HarnessOutput[] = [
      {
        kind: "event",
        event: {
          type: "turn.autonomous.started",
          turnId: TURN,
          input: [{ type: "text", text: secret }],
        },
      },
      {
        kind: "event",
        event: {
          type: "item.completed",
          turnId: TURN,
          snapshot: itemSnapshot({ type: "reasoning", itemId: "i1" as never, text: secret }),
        },
      },
      {
        kind: "event",
        event: {
          type: "item.completed",
          turnId: TURN,
          snapshot: itemSnapshot({
            type: "commandExecution",
            itemId: "i2" as never,
            command: `rm ${secret}`,
            cwd: `/home/user/${secret}`,
            output: secret,
            exitCode: 1,
          }),
        },
      },
      {
        kind: "event",
        event: {
          type: "item.completed",
          turnId: TURN,
          snapshot: itemSnapshot({
            type: "toolExecution",
            itemId: "i3" as never,
            toolName: "Read",
            arguments: { path: secret },
            output: { content: [{ type: "text", text: secret }] },
          }),
        },
      },
      {
        kind: "event",
        event: {
          type: "item.completed",
          turnId: TURN,
          snapshot: itemSnapshot({
            type: "fileChange",
            itemId: "i4" as never,
            changes: [{ path: `src/${secret}.ts`, kind: "update", unifiedDiff: secret }],
          }),
        },
      },
      {
        kind: "event",
        event: {
          type: "item.completed",
          turnId: TURN,
          snapshot: itemSnapshot({
            type: "subagentDelegation",
            itemId: "i5" as never,
            operation: "spawn",
            prompt: secret,
            subagents: [
              { subagentId: "s1", description: secret, background: false, status: "running" },
            ],
          }),
        },
      },
      {
        kind: "interaction",
        interaction: {
          type: "question",
          interactionId: "x1" as never,
          turnId: TURN,
          title: secret,
          questions: [
            {
              id: "q1",
              type: "text",
              prompt: secret,
              multiline: false,
              secret: true,
              optional: false,
              prefill: secret,
            },
          ],
        },
      },
      {
        kind: "interaction",
        interaction: {
          type: "approval",
          interactionId: "x2" as never,
          turnId: TURN,
          title: secret,
          description: secret,
          subject: { type: "nativeAction" },
          actions: [{ id: "a1", label: secret, effect: "allowOnce" }],
        },
      },
    ];
    for (const output of outputs) log.output(output);

    expect(records.length).toBe(outputs.length);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it("keeps shape and size for each Item type", () => {
    const { records, log } = collector();
    log.output({
      kind: "event",
      event: {
        type: "item.completed",
        turnId: TURN,
        snapshot: itemSnapshot({
          type: "commandExecution",
          itemId: "i1" as never,
          command: "npm test",
          output: "abc",
          exitCode: 2,
          outputTruncated: true,
          durationMs: 1_234,
        }),
      },
    });
    log.output({
      kind: "event",
      event: {
        type: "item.completed",
        turnId: TURN,
        snapshot: itemSnapshot({
          type: "fileChange",
          itemId: "i2" as never,
          changes: [
            { path: "a.ts", kind: "update", unifiedDiff: "" },
            { path: "b.ts", kind: "add", unifiedDiff: "" },
            { path: "c.ts", kind: "update", unifiedDiff: "" },
          ],
        }),
      },
    });
    expect(records[0]?.fields).toMatchObject({
      exitCode: 2,
      outputChars: 3,
      outputTruncated: true,
      durationMs: 1_234,
    });
    expect(records[1]?.fields).toMatchObject({
      fileCount: 3,
      changeKinds: { update: 2, add: 1 },
    });
  });

  it("raises the level and keeps native failure detail for a failed Turn", () => {
    const { records, log } = collector();
    log.output({ kind: "event", event: { type: "turn.started", turnId: TURN } });
    log.output({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId: TURN,
        nativeTurnRef: {
          harnessId: "pi" as never,
          nativeSessionId: "native-1",
          nativeTurnKey: "turn:3",
          formatVersion: 1,
        },
        outcome: {
          status: "failed",
          error: {
            code: "processExited",
            message: "Harness exited",
            retryable: true,
            stage: "turn",
            stderrTail: "native stderr tail",
          },
        },
      },
    });
    const completed = records.at(-1);
    expect(completed?.level).toBe("error");
    expect(completed?.fields).toMatchObject({
      status: "failed",
      nativeTurnKey: "turn:3",
      durationMs: 500,
      error: {
        code: "processExited",
        message: "Harness exited",
        retryable: true,
        stage: "turn",
        stderrTail: "native stderr tail",
      },
    });
  });

  it("records a faulted Session as an error", () => {
    const { records, log } = collector();
    log.output({
      kind: "event",
      event: {
        type: "session.faulted",
        error: { code: "protocolError", message: "bad frame", retryable: false },
      },
    });
    expect(records[0]).toMatchObject({
      level: "error",
      event: "session.faulted",
      fields: { error: { code: "protocolError", message: "bad frame" } },
    });
  });

  it("records only changed Session configuration", () => {
    const { records, log } = collector();
    const state = {
      nativeRef: {
        harnessId: "pi" as never,
        nativeSessionId: "native-1",
        formatVersion: 1 as const,
      },
      effectiveModel: { id: "model-a" as never },
    };
    log.output({ kind: "event", event: { type: "session.state.changed", state } });
    log.output({ kind: "event", event: { type: "session.state.changed", state } });
    log.output({
      kind: "event",
      event: {
        type: "session.state.changed",
        state: { ...state, effectiveModel: { id: "model-b" as never } },
      },
    });
    expect(records.map(({ fields }) => fields.modelId)).toEqual(["model-a", "model-b"]);
  });

  it("does not leak per-Item state across Turns", () => {
    const { log, records } = collector();
    const second = "turn-2" as HostTurnId;
    log.output({ kind: "event", event: { type: "turn.started", turnId: TURN } });
    log.output({
      kind: "event",
      event: {
        type: "item.started",
        turnId: TURN,
        item: { type: "reasoning", itemId: "shared" as never, text: "" },
      },
    });
    log.output({
      kind: "event",
      event: { type: "turn.completed", turnId: TURN, outcome: { status: "cancelled" } },
    });
    log.output({ kind: "event", event: { type: "turn.started", turnId: second } });
    log.output({
      kind: "event",
      event: {
        type: "item.updated",
        turnId: second,
        itemId: "shared" as never,
        update: { type: "text.append", text: "late" },
      },
    });
    log.output({
      kind: "event",
      event: { type: "turn.completed", turnId: second, outcome: { status: "succeeded" } },
    });
    // The first Turn's Item trace must not absorb updates belonging to the second Turn.
    expect(records.filter(({ event: name }) => name === "item.completed")).toEqual([]);
    expect(records.at(-1)?.fields).toMatchObject({ turnId: second, items: {} });
  });
});
