import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mapClaudeSnapshot } from "../src/claude-history.js";
import { readClaudeTranscript } from "../src/claude-transcript.js";
import { historyMessage as message, queuedCommand } from "./fixtures/claude-queued-command.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function transcript(entries: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-queued-history-"));
  directories.push(directory);
  const project = path.join(directory, "projects", "-work");
  await mkdir(project, { recursive: true });
  const file = path.join(project, "session-1.jsonl");
  const contents = entries.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(file, contents);
  const input = {
    cwd: "/work",
    sessionId: "session-1",
    environment: { CLAUDE_CONFIG_DIR: directory },
  };
  return { file, contents, input };
}

async function readTranscript(input: Parameters<typeof readClaudeTranscript>[0]) {
  const values = await readClaudeTranscript(input);
  if (!values) throw new Error("Expected the test transcript to exist");
  return values;
}

const opening = message("user", "root-user", "run two tools");
const final = message("assistant", "root-final", [{ type: "text", text: "done" }]);

function tool(id: string) {
  return message("assistant", `call-${id}`, [
    { type: "tool_use", id, name: "Bash", input: { command: `printf '${id}'` } },
  ]);
}

function result(id: string) {
  return message("user", `result-${id}`, [{ type: "tool_result", tool_use_id: id, content: id }]);
}

describe("Claude queued human history", () => {
  it("restores consecutive steers in native append order without changing Turn or checkpoint", async () => {
    // The enqueue timestamp predates the preceding Tool result; it is not a sorting key.
    const entries = [
      opening,
      tool("one"),
      result("one"),
      queuedCommand("attachment-1", "input-1", "same text"),
      tool("two"),
      result("two"),
      queuedCommand("attachment-2", "input-2", "same text"),
      final,
      message("user", "next-user", "next request"),
      message("assistant", "next-final", "next answer"),
    ];
    const native = await transcript(entries);
    const values = await readTranscript(native.input);
    const snapshot = mapClaudeSnapshot(values, "session-1");
    expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "root-user",
      "next-user",
    ]);
    expect(snapshot.turns[0]?.checkpoint?.checkpointId).toBe("root-final");
    expect(snapshot.turns[0]?.items.map(({ item }) => item.type)).toEqual([
      "commandExecution",
      "userMessage",
      "commandExecution",
      "userMessage",
      "agentMessage",
    ]);
    expect(snapshot.turns[0]?.items.filter(({ item }) => item.type === "userMessage")).toEqual([
      {
        item: {
          type: "userMessage",
          itemId: "attachment-1",
          input: [{ type: "text", text: "same text" }],
        },
        outcome: { status: "succeeded" },
      },
      {
        item: {
          type: "userMessage",
          itemId: "attachment-2",
          input: [{ type: "text", text: "same text" }],
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(snapshot.turns[0]?.items.at(-1)?.item.itemId).toBe(
      "claude-item-v2-root-user-agentMessage-1",
    );
    expect(mapClaudeSnapshot(await readTranscript(native.input), "session-1")).toEqual(snapshot);
    expect(await readFile(native.file, "utf8")).toBe(native.contents);
  });

  it("normalizes repeated attachment UUIDs using their latest record at the original position", async () => {
    const first = queuedCommand("attachment-1", "input-1", "first");
    const second = queuedCommand("attachment-2", "input-2", "second");
    const native = await transcript([opening, first, second, final, { ...first, rendered: [] }]);
    const values = await readTranscript(native.input);
    expect(values.map((value) => (value as { uuid: string }).uuid)).toEqual([
      "root-user",
      "attachment-1",
      "attachment-2",
      "root-final",
    ]);
    expect(
      mapClaudeSnapshot(values, "session-1").turns[0]?.items.map(({ item }) => item.type),
    ).toEqual(["userMessage", "userMessage", "agentMessage"]);
    await writeFile(
      native.file,
      `${native.contents}\n${JSON.stringify({ ...first, isMeta: true })}`,
    );
    expect(
      mapClaudeSnapshot(await readTranscript(native.input), "session-1")
        .turns[0]?.items.filter(({ item }) => item.type === "userMessage")
        .map(({ item }) => item.itemId),
    ).toEqual(["attachment-2"]);
  });

  it("deduplicates repeated delivery identity, never identical text from different inputs", () => {
    const snapshot = mapClaudeSnapshot(
      [
        opening,
        queuedCommand("first", "input-1", "repeat"),
        queuedCommand("replayed", "input-1", "repeat"),
        queuedCommand("second", "input-2", "repeat"),
        final,
      ],
      "session-1",
    );
    expect(
      snapshot.turns[0]?.items
        .filter(({ item }) => item.type === "userMessage")
        .map(({ item }) => item.itemId),
    ).toEqual(["first", "second"]);
    expect(() =>
      mapClaudeSnapshot(
        [
          opening,
          queuedCommand("a", "same-id", "one"),
          queuedCommand("b", "same-id", "different"),
          final,
        ],
        "session-1",
      ),
    ).toThrow("different prompts");
  });

  const ignored = [
    { attachment: { type: "file", prompt: "not input" } },
    { attachment: { commandMode: "bash" } },
    { attachment: { origin: { kind: "task-notification" } } },
    { attachment: { origin: undefined } },
    { attachment: { humanTurn: false } },
    { attachment: { isMeta: true } },
    { attachment: { isSynthetic: true } },
    { isMeta: true },
    { isSynthetic: true },
    { isSidechain: true },
    { parent_tool_use_id: "agent-tool" },
    { origin: { kind: "task-notification" } },
    { sessionId: "foreign-session" },
    { session_id: "foreign-session" },
  ];
  it.each(ignored)("does not promote non-human or non-prompt attachments: %j", (change) => {
    const base = queuedCommand("attachment", "input", "notification");
    const value = { ...base, ...change, attachment: { ...base.attachment, ...change.attachment } };
    const snapshot = mapClaudeSnapshot([opening, value, final], "session-1");
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items.map(({ item }) => item.type)).toEqual(["agentMessage"]);
  });

  it("preserves human text quoting notification markup instead of guessing origin from text", () => {
    const text = "<task-notification>quoted text</task-notification>";
    const snapshot = mapClaudeSnapshot(
      [opening, queuedCommand("a", "s", text), final],
      "session-1",
    );
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({
      type: "userMessage",
      input: [{ text }],
    });
  });

  it.each([false, true])("keeps a real new user Turn authoritative (forked=%s)", (forked) => {
    const next = message("user", forked ? "copied-input" : "input", "same prompt");
    const snapshot = mapClaudeSnapshot(
      [
        opening,
        final,
        queuedCommand("a", "input", "same prompt"),
        { ...next, ...(forked ? { forkedFrom: { messageUuid: "input" } } : {}) },
        message("assistant", "next-final", "answer"),
      ],
      "session-1",
    );
    expect(snapshot.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
      "root-user",
      forked ? "copied-input" : "input",
    ]);
    expect(
      snapshot.turns.flatMap((turn) => turn.items).some(({ item }) => item.type === "userMessage"),
    ).toBe(false);
  });

  it("does not invent a Turn or a checkpoint from a delivered attachment", () => {
    const queued = queuedCommand("attachment", "sdk-input", "continue");
    expect(() => mapClaudeSnapshot([queued, final], "session-1")).toThrow("no native Turn anchor");
    const unfinished = mapClaudeSnapshot([opening, final, queued], "session-1");
    expect(unfinished.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("root-user");
    expect(unfinished.turns[0]?.checkpoint).toBeUndefined();
    expect(unfinished.turns[0]?.outcome.status).toBe("unknown");
    const continued = mapClaudeSnapshot(
      [opening, final, queued, message("assistant", "continuation-final", "continued")],
      "session-1",
    );
    expect(continued.turns).toHaveLength(1);
    expect(continued.turns[0]?.checkpoint?.checkpointId).toBe("continuation-final");
  });

  it("preserves root failure and cancellation without failing the accepted user Item", () => {
    const failed = mapClaudeSnapshot(
      [opening, queuedCommand("a", "s", "continue"), { ...final, isApiErrorMessage: true }],
      "session-1",
    );
    expect(failed.turns[0]?.outcome.status).toBe("failed");
    expect(failed.turns[0]?.items[0]?.outcome.status).toBe("succeeded");
    const cancelled = mapClaudeSnapshot(
      [
        { ...opening, promptId: "prompt", promptSource: "sdk" },
        queuedCommand("a", "s", "continue"),
        {
          ...message("user", "interrupted", [
            { type: "text", text: "[Request interrupted by user]" },
          ]),
          promptId: "prompt",
        },
      ],
      "session-1",
    );
    expect(cancelled.turns[0]).toMatchObject({
      outcome: { status: "cancelled" },
      checkpoint: { checkpointId: "interrupted" },
    });
  });

  it.each([{ uuid: "" }, { attachment: { source_uuid: "" } }, { attachment: { prompt: [] } }])(
    "rejects malformed identified human input: %j",
    (change) => {
      const base = queuedCommand("a", "s", "prompt");
      const value = {
        ...base,
        ...change,
        attachment: { ...base.attachment, ...change.attachment },
      };
      expect(() => mapClaudeSnapshot([opening, value, final], "session-1")).toThrow(
        "invalid identity or text prompt",
      );
    },
  );
});
