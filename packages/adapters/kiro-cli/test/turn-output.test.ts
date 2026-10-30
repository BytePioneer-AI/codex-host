import { describe, expect, it } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import { KiroTurnOutput } from "../src/turn-output.js";

const turnId = hostTurnIdSchema.parse("message-phases");

describe("Kiro progress and final answer presentation", () => {
  it.each(["confirmed", "failed", "cancelled", "missing-diff"] as const)(
    "shows pending native diffs before approval and settles preview on %s",
    (result) => {
      const outputs: HarnessOutput[] = [];
      const messages: Array<{ method?: unknown; params?: unknown }> = [];
      const projector = new CodexTurnProjector({
        threadId: "thread",
        turnId,
        cwd: "/workspace",
        startedAtMs: 0,
      });
      projector.project({ type: "turn.started", turnId });
      const turn = new KiroTurnOutput(turnId, "/workspace", (output) => {
        outputs.push(output);
        if (
          output.kind === "event" &&
          "turnId" in output.event &&
          output.event.type !== "turn.autonomous.started"
        )
          messages.push(...projector.project(output.event).messages);
      });
      const content = [
        { type: "diff", path: "/workspace/a.txt", oldText: "alpha\n", newText: "beta\n" },
      ];
      turn.accept({
        type: "tool.call",
        callId: "edit",
        title: "Replace in File",
        kind: "edit",
        status: "in_progress",
      });
      turn.accept({ type: "tool.update", callId: "edit", status: "pending", content });
      expect(outputs).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "item.started",
            item: expect.objectContaining({ type: "fileChange" }),
          }),
        }),
      );
      expect(outputs.some((o) => o.kind === "event" && o.event.type === "item.completed")).toBe(
        false,
      );
      expect(
        messages.find((m) => m.method === "item/fileChange/patchUpdated")?.params,
      ).toMatchObject({
        changes: [expect.objectContaining({ diff: expect.stringContaining("+beta") })],
      });
      if (result !== "cancelled")
        turn.accept({
          type: "tool.update",
          callId: "edit",
          status: result === "failed" ? "failed" : "completed",
          ...(result === "confirmed" ? { content: [{ ...content[0], newText: "gamma\n" }] } : {}),
        });
      turn.finish(result === "cancelled" ? { status: "cancelled" } : { status: "succeeded" });
      const files = outputs.flatMap((o) =>
        o.kind === "event" &&
        o.event.type === "item.completed" &&
        o.event.snapshot.item.type === "fileChange"
          ? [o.event.snapshot]
          : [],
      );
      expect(files).toHaveLength(1);
      expect(files[0]?.outcome.status).toBe(
        result === "confirmed" ? "succeeded" : result === "failed" ? "failed" : "cancelled",
      );
      if (result !== "confirmed") {
        expect(files[0]?.item).toMatchObject({ changes: [] });
        expect(
          messages.filter((m) => m.method === "turn/diff/updated").at(-1)?.params,
        ).toMatchObject({ diff: "" });
      } else
        expect(files[0]?.item).toMatchObject({
          changes: [expect.objectContaining({ unifiedDiff: expect.stringContaining("+gamma") })],
        });
      expect(() =>
        projector.project({ type: "turn.completed", turnId, outcome: { status: "succeeded" } }),
      ).not.toThrow();
    },
  );

  it("keeps progress and tools before the final answer and projects the native duration header", () => {
    const outputs: HarnessOutput[] = [];
    const turn = new KiroTurnOutput(turnId, "/workspace", (output) => outputs.push(output));
    turn.accept({ type: "agent.text", text: "First inspect ", messageId: "progress-say" });
    turn.accept({ type: "agent.text", text: "the source.", messageId: "progress-say" });
    turn.accept({
      type: "tool.call",
      callId: "read",
      title: "Read",
      name: "read_file",
      status: "in_progress",
      rawInput: { path: "source.rs" },
    });
    turn.accept({ type: "tool.update", callId: "read", status: "completed", rawOutput: "source" });
    turn.accept({ type: "agent.text", text: "Now compile.", messageId: "compile-say" });
    turn.accept({
      type: "tool.call",
      callId: "compile",
      title: "Compile",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "rustc source.rs" },
    });
    turn.accept({
      type: "tool.update",
      callId: "compile",
      status: "completed",
      rawOutput: { output: "ok", exitCode: 0 },
    });
    turn.accept({ type: "agent.text", text: "Implemented ", messageId: "final-say" });
    turn.accept({ type: "agent.text", text: "and verified.", messageId: "final-say" });
    turn.finish({ status: "succeeded" });

    const events = outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
    const starts = events.filter((event) => event.type === "item.started");
    expect(starts.map((event) => event.item.type)).toEqual([
      "agentMessage",
      "toolExecution",
      "agentMessage",
      "commandExecution",
      "agentMessage",
    ]);
    expect(new Set(starts.map((event) => event.item.itemId)).size).toBe(5);
    const messages = events
      .filter((event) => event.type === "item.completed")
      .map((event) => event.snapshot.item)
      .filter((item) => item.type === "agentMessage");
    expect(messages.map(({ text, phase }) => ({ text, phase }))).toEqual([
      { text: "First inspect the source.", phase: "commentary" },
      { text: "Now compile.", phase: "commentary" },
      { text: "Implemented and verified.", phase: "final_answer" },
    ]);
    const projector = new CodexTurnProjector({
      threadId: "kiro-thread",
      turnId,
      cwd: "/workspace",
      startedAtMs: 1_000,
    });
    projector.project({ type: "turn.started", turnId }, 1_000);
    for (const event of events) {
      if ("turnId" in event && event.type !== "turn.autonomous.started")
        projector.project(event, 2_000);
    }
    const completed = projector.project(
      {
        type: "turn.completed",
        turnId,
        outcome: { status: "succeeded" },
      },
      104_000,
    ).completedTurn;
    expect(completed).toMatchObject({
      durationMs: 103_000,
      items: [
        { type: "agentMessage", text: "First inspect the source.", phase: "commentary" },
        { type: "agentMessage", text: "Now compile.", phase: "commentary" },
        { type: "agentMessage", text: "Implemented and verified.", phase: "final_answer" },
      ],
    });
  });

  it("uses message identity boundaries even without an intervening tool", () => {
    const outputs: HarnessOutput[] = [];
    const turn = new KiroTurnOutput(turnId, "/workspace", (output) => outputs.push(output));
    turn.accept({ type: "agent.text", text: "Working", messageId: "one-say" });
    turn.accept({ type: "agent.text", text: "Done", messageId: "two-say" });
    turn.finish({ status: "succeeded" });
    const items = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "item.completed"
        ? [output.event.snapshot.item]
        : [],
    );
    expect(items).toMatchObject([
      { text: "Working", phase: "commentary" },
      { text: "Done", phase: "final_answer" },
    ]);
  });

  it("splits at tool starts without native message IDs and does not label cancelled output final", () => {
    const outputs: HarnessOutput[] = [];
    const turn = new KiroTurnOutput(turnId, "/workspace", (output) => outputs.push(output));
    turn.accept({ type: "agent.text", text: "Working" });
    turn.accept({ type: "tool.call", callId: "read", title: "Read", status: "pending" });
    turn.accept({ type: "agent.text", text: "Partial response" });
    turn.finish({ status: "cancelled" });
    const messages = outputs.flatMap((output) =>
      output.kind === "event" &&
      output.event.type === "item.completed" &&
      output.event.snapshot.item.type === "agentMessage"
        ? [output.event.snapshot.item]
        : [],
    );
    expect(messages.map((message) => message.phase)).toEqual(["commentary", "commentary"]);
    expect(messages.map((message) => message.text)).toEqual(["Working", "Partial response"]);
  });
});
