import assert from "node:assert/strict";
import { defined } from "./support/defined.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  TurnProjector,
  diffTexts,
  normalizeTool,
  type HostItem,
  type HostItemOutcome,
  type HostItemUpdate,
  type TurnOutcomeShape,
} from "../src/projector.ts";
import { SessionLog, type WireEvent } from "../src/session-log.ts";
import { DataDir } from "../src/store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newLog(): SessionLog {
  const root = mkdtempSync(join(tmpdir(), "codexhost-projector-"));
  dirs.push(root);
  return new SessionLog(
    { version: 4, id: "session-test", createdAt: 0, isSeeded: false },
    new DataDir(root),
    () => {},
  );
}

/** Feed one Harness output the way Sessions.onEvent does. */
function feed(projector: TurnProjector, event: Record<string, unknown> & { type: string }): void {
  switch (event.type) {
    case "item.started":
      projector.itemStarted(event.item as HostItem);
      break;
    case "item.updated":
      projector.itemUpdated(String(event.itemId), event.update as HostItemUpdate);
      break;
    case "item.completed": {
      const snapshot = event.snapshot as { item: HostItem; outcome: HostItemOutcome };
      projector.itemCompleted(snapshot.item, snapshot.outcome);
      break;
    }
    case "turn.completed":
      projector.finish(event.outcome as TurnOutcomeShape);
      break;
    default:
      break;
  }
}

function messages(
  events: readonly WireEvent[],
): Array<{ step: number; content: Array<{ type: string; text?: string; name?: string }> }> {
  return events
    .filter((event) => event.type === "assistant/message")
    .map((event) => {
      const data = event.data as {
        step: number;
        message: { content: Array<{ type: string; text?: string; name?: string }> };
      };
      return { step: data.step, content: data.message.content };
    });
}

function assertBalancedSteps(events: readonly WireEvent[]): void {
  let open = 0;
  for (const event of events) {
    if (event.type === "step/start") {
      assert.equal(open, 0, `step opened while another is open at seq ${String(event.seq)}`);
      open += 1;
    }
    if (event.type === "step/end") {
      assert.equal(open, 1, `step closed without an open step at seq ${String(event.seq)}`);
      open -= 1;
    }
  }
  assert.equal(open, 0);
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index),
    "seqs are dense",
  );
}

describe("TurnProjector", () => {
  it("keeps text a Harness appends to a message Item that spans a tool call (recorded Claude Code turn)", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: true });
    projector.begin([{ type: "text", text: "ask me" }], "request-1");
    const fixture = readFileSync(
      join(import.meta.dirname, "fixtures/claude-question-spanning-tool.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { kind: string; event?: Record<string, unknown> & { type: string } },
      );
    for (const output of fixture)
      if (output.kind === "event" && output.event !== undefined) feed(projector, output.event);
    assert.ok(projector.isFinished);
    const assistant = messages(log.events);
    assert.deepEqual(
      assistant.map((message) => message.content.map((part) => part.type)),
      [["tool-call"], ["text"]],
    );
    assert.equal(assistant[1]?.content[0]?.text, "Blue");
    assert.ok(
      defined(assistant[1]).step > defined(assistant[0]).step,
      "narration after the tool opens a later step",
    );
    assertBalancedSteps(log.events);
    assert.equal(log.events.at(-1)?.type, "turn/end");
  });

  it("projects narrate → act → narrate as two steps with one tool pair", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: true, cwd: "/w" });
    projector.begin([{ type: "text", text: "list files" }], undefined);
    projector.itemStarted({ type: "agentMessage", itemId: "m1", text: "" });
    projector.itemUpdated("m1", { type: "text.append", text: "Listing." });
    projector.itemCompleted(
      { type: "agentMessage", itemId: "m1", text: "Listing." },
      { status: "succeeded" },
    );
    projector.itemStarted({ type: "commandExecution", itemId: "c1", command: "ls", cwd: "/w" });
    projector.itemUpdated("c1", { type: "output.append", text: "a\nb\n" });
    projector.itemCompleted(
      { type: "commandExecution", itemId: "c1", command: "ls", cwd: "/w", exitCode: 2 },
      { status: "succeeded" },
    );
    projector.itemStarted({ type: "agentMessage", itemId: "m2", text: "Two files." });
    projector.itemCompleted(
      { type: "agentMessage", itemId: "m2", text: "Two files." },
      { status: "succeeded" },
    );
    projector.finish({ status: "succeeded" });

    const assistant = messages(log.events);
    assert.deepEqual(
      assistant.map((message) => message.step),
      [1, 2],
    );
    assert.deepEqual(
      defined(assistant[0]).content.map((part) => part.type),
      ["text", "tool-call"],
    );
    const call = defined(log.events.find((event) => event.type === "tool/call")).data as {
      name: string;
      arguments: string;
    };
    assert.equal(call.name, "bash");
    assert.deepEqual(JSON.parse(call.arguments), { command: "ls" });
    const result = defined(log.events.find((event) => event.type === "tool/result"));
    const text = defined(
      (result.data as { message: { content: Array<{ text: string }> } }).message.content[0],
    ).text;
    assert.equal(text, "a\nb\n\n[exit code: 2]");
    assert.deepEqual(result.sourceEventSeqs, [
      defined(log.events.find((event) => event.type === "tool/call")).seq,
    ]);
    assertBalancedSteps(log.events);
  });

  it("does not commit an empty assistant message for a failed attempt", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: true });
    projector.begin([{ type: "text", text: "hi" }], undefined);
    projector.itemStarted({ type: "reasoning", itemId: "r1", text: "" });
    projector.finish({
      status: "failed",
      error: { code: "nativeFailure", message: "auth expired" },
    });
    assert.equal(messages(log.events).length, 0);
    const end = defined(log.events.at(-1));
    assert.equal(end.type, "turn/end");
    assert.deepEqual((end.data as { reason: unknown }).reason, {
      kind: "error",
      error: { message: "auth expired", code: "nativeFailure" },
    });
    assertBalancedSteps(log.events);
  });

  it("settles tools the Harness never completed when the turn ends", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: true });
    projector.begin([{ type: "text", text: "run" }], undefined);
    projector.itemStarted({ type: "commandExecution", itemId: "c1", command: "sleep 100" });
    projector.finish({ status: "cancelled" });
    const result = defined(log.events.find((event) => event.type === "tool/result"));
    assert.equal((result.data as { message: { isError: boolean } }).message.isError, true);
    assert.deepEqual((defined(log.events.at(-1)).data as { reason: unknown }).reason, {
      kind: "aborted",
      reason: { kind: "user" },
    });
  });

  it("maps Claude Code file tools onto DSH diff views", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: false });
    projector.begin([{ type: "text", text: "edit" }], undefined);
    const edit: HostItem = {
      type: "toolExecution",
      itemId: "t1",
      toolName: "Edit",
      arguments: { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
    };
    projector.itemCompleted(edit, { status: "succeeded" });
    projector.finish({ status: "succeeded" });
    const call = defined(log.events.find((event) => event.type === "tool/call")).data as {
      name: string;
    };
    assert.equal(call.name, "edit");
    const result = defined(log.events.find((event) => event.type === "tool/result")).data as {
      meta: unknown;
    };
    assert.deepEqual(result.meta, { diffs: [{ path: "/w/a.ts", oldText: "a", newText: "b" }] });
  });

  it("replays history without presentation frames", () => {
    const log = newLog();
    const frames: unknown[] = [];
    log.follow(
      {
        id: "f",
        closed: false,
        push: (frame) => frames.push(frame),
        end() {},
        fail() {},
        onClose() {},
      },
      {},
    );
    const projector = new TurnProjector(log, { live: false });
    projector.begin([{ type: "text", text: "q" }], undefined);
    projector.itemCompleted(
      { type: "agentMessage", itemId: "m", text: "answer" },
      { status: "succeeded" },
    );
    projector.finish({ status: "succeeded" });
    assert.equal(
      frames.filter((frame) => (frame as { type: string }).type === "assistant-stream").length,
      0,
    );
    assert.equal(messages(log.events)[0]?.content[0]?.text, "answer");
  });
});

describe("tool normalization", () => {
  it("normalizes Pi argument names", () => {
    assert.deepEqual(normalizeTool("edit", { path: "x", oldText: "a", newText: "b" }), {
      name: "edit",
      args: {
        path: "x",
        oldText: "a",
        newText: "b",
        file_path: "x",
        old_string: "a",
        new_string: "b",
      },
    });
    assert.deepEqual(normalizeTool("WebSearch", { query: "q" }), {
      name: "web_search",
      args: { query: "q", queries: ["q"] },
    });
    assert.deepEqual(normalizeTool("mcp__server__tool", { a: 1 }), {
      name: "mcp__server__tool",
      args: { a: 1 },
    });
  });

  it("splits unified diffs into before/after texts", () => {
    const texts = diffTexts({
      path: "f",
      kind: "update",
      unifiedDiff: "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new",
    });
    assert.deepEqual(texts, { path: "f", oldText: "keep\nold", newText: "keep\nnew" });
    assert.equal(diffTexts({ path: "n", kind: "add", unifiedDiff: "+x" }).oldText, null);
  });
});

describe("tool output cap", () => {
  it("keeps head and tail of oversized tool output", async () => {
    const { capText } = await import("../src/projector.ts");
    const big = `${"a".repeat(150_000)}END`;
    const capped = capText(big);
    assert.ok(capped.length < 100_200);
    assert.ok(capped.startsWith("aaa"));
    assert.ok(capped.endsWith("END"));
    assert.match(capped, /characters truncated/u);
    assert.equal(capText("short"), "short");
  });
});

describe("Claude Code AskUserQuestion", () => {
  it("renders through the DSH question card with synthesized ids and parsed answers", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: false });
    projector.begin([{ type: "text", text: "ask" }], undefined);
    const item: HostItem = {
      type: "toolExecution",
      itemId: "q",
      toolName: "AskUserQuestion",
      arguments: {
        questions: [
          {
            question: "Which color do you prefer?",
            header: "Color",
            multiSelect: false,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
      output: {
        content: [
          {
            type: "text",
            text: 'Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue.',
          },
        ],
      },
    };
    projector.itemCompleted(item, { status: "succeeded" });
    projector.finish({ status: "succeeded" });
    const call = defined(log.events.find((event) => event.type === "tool/call")).data as {
      name: string;
      arguments: string;
    };
    assert.equal(call.name, "ask_user_question");
    assert.equal(
      defined((JSON.parse(call.arguments) as { questions: Array<{ id: string }> }).questions[0]).id,
      "q0",
    );
    const result = defined(log.events.find((event) => event.type === "tool/result")).data as {
      message: { content: Array<{ text: string }> };
    };
    assert.deepEqual(JSON.parse(defined(result.message.content[0]).text), {
      answers: [{ id: "q0", selected: ["Blue"] }],
    });
  });
});

describe("orphaned turns", () => {
  it("closes a turn a previous process left open", () => {
    const log = newLog();
    const projector = new TurnProjector(log, { live: true });
    projector.begin([{ type: "text", text: "long task" }], undefined);
    projector.itemStarted({ type: "agentMessage", itemId: "m", text: "partial" });
    // The process dies here: no finish().
    assert.equal(log.closeOrphanedTurn(), true);
    const tail = log.events.slice(-2).map((event) => event.type);
    assert.deepEqual(tail, ["step/end", "turn/end"]);
    assert.deepEqual((defined(log.events.at(-1)).data as { reason: unknown }).reason, {
      kind: "interrupted",
    });
    assert.equal(log.closeOrphanedTurn(), false);
    assertBalancedSteps(log.events);
  });
});

describe("live tool output", () => {
  it("keeps output that arrives before the tool starts and reports settlement", () => {
    const log = newLog();
    const outputs: Array<[string, string | undefined]> = [];
    const projector = new TurnProjector(log, {
      live: true,
      onToolOutput: (callId, output) => outputs.push([callId, output]),
    });
    projector.begin([{ type: "text", text: "run" }], undefined);
    projector.itemUpdated("c1", { type: "output.append", text: "line 1\n" });
    projector.itemStarted({ type: "commandExecution", itemId: "c1", command: "seq 2" });
    projector.itemUpdated("c1", { type: "output.append", text: "line 2\n" });
    projector.itemCompleted(
      { type: "commandExecution", itemId: "c1", command: "seq 2", exitCode: 0 },
      { status: "succeeded" },
    );
    assert.deepEqual(outputs, [
      ["c1", "line 1\n"],
      ["c1", "line 1\nline 2\n"],
      ["c1", undefined],
    ]);
    const result = defined(log.events.find((event) => event.type === "tool/result")).data as {
      message: { content: Array<{ text: string }> };
    };
    assert.equal(defined(result.message.content[0]).text, "line 1\nline 2\n");
  });
});
