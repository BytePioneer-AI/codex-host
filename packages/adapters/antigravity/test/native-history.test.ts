import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { nativeSessionRefSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { readDerivationBoundaries } from "../src/fork.js";
import { readNativeTurnCompactions } from "../src/native-replay.js";
import { nativeConversationDbPath } from "../src/native-turn-boundaries.js";
import {
  isTimestampInPromptWindows,
  readPromptWindows,
  savePromptWindows,
} from "../src/prompt-windows.js";
import {
  answerStep,
  checkpointStep,
  createNativeHistoryDatabase,
  planModeSwitch,
  runField,
  systemStep,
  textField,
  userStep,
} from "../../../../tests/fixtures/antigravity/native-history-fixture.js";
import {
  bytes,
  nanoseconds,
} from "../../../../tests/fixtures/antigravity/native-timing-fixture.js";

const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "antigravity",
  nativeSessionId: "history",
  formatVersion: 1,
});
const callFields = (id: string, name: string, args: object) =>
  Buffer.concat([textField(1, id), textField(2, name), textField(3, JSON.stringify(args))]);
const call = (id: string, name: string, args: object) => bytes(7, callFields(id, name, args));
const callMetadata = (id: string) => bytes(5, bytes(4, textField(1, id)));
const result = (id: string, output: string) =>
  Buffer.concat([callMetadata(id), bytes(140, bytes(2, textField(1, output)))]);
const commandResult = (id: string, command: string, output?: string, run = "") =>
  Buffer.concat([
    bytes(
      5,
      Buffer.concat([
        bytes(4, callFields(id, "run_command", { CommandLine: command })),
        textField(12, run),
      ]),
    ),
    ...(output === undefined ? [] : [bytes(140, bytes(2, textField(1, output)))]),
  ]);

describe("native session history", () => {
  let home: string;
  let adapter: AntigravityAdapter;
  let transportStarts: number;
  beforeEach(async () => {
    transportStarts = 0;
    home = await mkdtemp(path.join(os.tmpdir(), "agy-native-history-"));
    adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      toolOutputLimit: 64,
      createTransport() {
        transportStarts++;
        throw new Error("History must not start ACP");
      },
    });
  });
  afterEach(async () => {
    await adapter.close();
    await rm(home, { recursive: true, force: true });
    expect(transportStarts).toBe(0);
  });

  it("decodes committed step content with merged inputs and stable item order", async () => {
    const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
    assert(opened.ok);
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
      answerStep(db, 15, "Second reply");
      userStep(db, 0, "First ");
      insert.run(1, 14, 3, bytes(19, textField(2, "question")));
      insert.run(
        3,
        15,
        3,
        bytes(
          20,
          Buffer.concat([
            textField(3, "Thinking"),
            call("read", "view_file", { path: "notes" }),
            call("missing", "find", { pattern: "none" }),
            call("pending", "view_file", { path: "waiting" }),
          ]),
        ),
      );
      insert.run(4, 132, 3, result("unrelated", "not a result for this Turn"));
      insert.run(
        5,
        132,
        7,
        Buffer.concat([callMetadata("missing"), bytes(31, textField(2, "Not found"))]),
      );
      insert.run(6, 132, 3, result("read", "x".repeat(128)));
      insert.run(7, 132, 2, result("pending", "Not settled yet"));
      insert.run(8, 132, 3, commandResult("command", "pwd", "/example"));
      insert.run(9, 132, 3, commandResult("command", "pwd", "duplicate output"));
      insert.run(10, 132, 5, commandResult("skipped", "pwd"));
      answerStep(db, 11, "First paragraph.");
      answerStep(db, 12, "Second paragraph.");
      insert.run(13, 17, 3, bytes(24, bytes(3, textField(2, "Retry suggested"))));
      userStep(db, 14, "Next question");

      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey)).toEqual([
        "turn-1",
        "turn-2",
      ]);
      expect(snapshot.value.turns.map((turn) => turn.checkpoint?.checkpointId)).toEqual([
        "turn-1",
        "turn-2",
      ]);
      expect(snapshot.value.turns.map((turn) => turn.input)).toEqual([
        [{ type: "text", text: "First question" }],
        [{ type: "text", text: "Next question" }],
      ]);
      expect(snapshot.value.turns[0]?.items).toMatchObject([
        { item: { type: "reasoning", text: "Thinking" } },
        {
          item: {
            type: "toolExecution",
            toolName: "view_file",
            arguments: { path: "notes" },
            output: { content: [{ type: "text", text: "x".repeat(64) }], truncated: true },
          },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "toolExecution",
            toolName: "find",
            output: { content: [{ type: "text", text: "Not found" }] },
          },
          outcome: { status: "failed" },
        },
        {
          item: { type: "toolExecution", arguments: { path: "waiting" } },
          outcome: { status: "cancelled" },
        },
        {
          item: { type: "commandExecution", command: "pwd", output: "/example", exitCode: 0 },
          outcome: { status: "succeeded" },
        },
        {
          item: {
            type: "agentMessage",
            text: "First paragraph.\n\nSecond paragraph.\n\n⚠ Retry suggested",
          },
        },
      ]);
      expect(snapshot.value.turns[1]?.items).toMatchObject([
        { item: { type: "agentMessage", text: "Second reply" } },
      ]);
      expect(await opened.value.readSnapshot()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it("projects terminal compaction checkpoints across foreground, /compact, and settled wake turns", async () => {
    const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
    assert(opened.ok);
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      // Passive compaction at turn start + mid-turn + cleared/in-flight skipped + failed error
      userStep(db, 0, "Work on repo", "r1");
      checkpointStep(db, 1, { status: 3, run: "r1", summary: "Internal summary not for chat" });
      answerStep(db, 2, "First part", "r1");
      checkpointStep(db, 3, { status: 5, run: "r1" });
      checkpointStep(db, 4, { status: 2, run: "r1" });
      checkpointStep(db, 5, { status: 7, run: "r1", error: "Compaction limit exceeded" });
      answerStep(db, 6, "Second part", "r1");
      // Standalone /compact turn must not merge with the next user turn
      userStep(db, 7, "/compact", "r2");
      checkpointStep(db, 8, { status: 3, run: "r2", summary: "Manual compact summary" });
      userStep(db, 9, "Follow up", "r3");
      answerStep(db, 10, "Done", "r3");
      // Settled autonomous wake with compaction before its planner reply
      systemStep(db, 11, "wake-ok");
      checkpointStep(db, 12, { status: 3, run: "wake-ok", summary: "Wake summary" });
      answerStep(db, 13, "Wake reply", "wake-ok");
      // Unsettled autonomous wake with checkpoint must be dropped
      systemStep(db, 14, "wake-dropped");
      checkpointStep(db, 15, { status: 3, run: "wake-dropped", summary: "Orphan summary" });

      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns).toHaveLength(4);
      expect(snapshot.value.turns[0]?.items).toMatchObject([
        {
          item: { type: "contextCompaction", itemId: "checkpoint-1" },
          outcome: { status: "succeeded" },
        },
        { item: { type: "agentMessage", text: "First part" } },
        {
          item: { type: "contextCompaction", itemId: "checkpoint-5" },
          outcome: {
            status: "failed",
            error: {
              code: "nativeFailure",
              message: "Compaction limit exceeded",
              retryable: false,
            },
          },
        },
        { item: { type: "agentMessage", text: "Second part" } },
      ]);
      expect(snapshot.value.turns[1]?.input).toEqual([{ type: "text", text: "/compact" }]);
      expect(snapshot.value.turns[1]?.items).toMatchObject([
        {
          item: { type: "contextCompaction", itemId: "checkpoint-8" },
          outcome: { status: "succeeded" },
        },
      ]);
      expect(snapshot.value.turns[2]?.input).toEqual([{ type: "text", text: "Follow up" }]);
      expect(snapshot.value.turns[2]?.items).toMatchObject([
        { item: { type: "agentMessage", text: "Done" } },
      ]);
      expect(snapshot.value.turns[3]?.nativeTurnRef.nativeTurnKey).toBe("wake-11");
      expect(snapshot.value.turns[3]?.items).toMatchObject([
        {
          item: { type: "contextCompaction", itemId: "checkpoint-12" },
          outcome: { status: "succeeded" },
        },
        { item: { type: "agentMessage", text: "Wake reply" } },
      ]);
      // Stable across repeated reads
      expect(await opened.value.readSnapshot()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it("splits committed wakes and ignores saved keys when assigning foreground boundaries", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
      userStep(db, 0, "你好", "user-1");
      systemStep(db, 1, "user-1");
      insert.run(2, 132, 3, commandResult("command", "echo foreground", "foreground", "user-1"));
      answerStep(db, 3, "你好！👋", "user-1");
      systemStep(db, 4, "wake-1");
      systemStep(db, 5, "wake-1");
      insert.run(6, 132, 3, commandResult("late", "echo late", "late", "user-1"));
      insert.run(7, 132, 3, commandResult("command", "echo wake", undefined, "wake-1"));
      insert.run(
        8,
        15,
        3,
        Buffer.concat([
          runField("wake-1"),
          bytes(
            20,
            Buffer.concat([
              call("command", "run_command", { CommandLine: "echo wake" }),
              call("read", "view_file", { path: "notes" }),
            ]),
          ),
        ]),
      );
      insert.run(9, 132, 3, commandResult("command", "echo wake", "late duplicate", "wake-1"));
      insert.run(10, 132, 3, result("read", "done"));
      answerStep(db, 11, "定时器已触发", "wake-1");
      systemStep(db, 12, "no-output");
      insert.run(13, 132, 3, commandResult("discard", "echo discard", "discard", "no-output"));
      userStep(db, 14, "next", "user-2");
      userStep(db, 15, " input", "user-2");
      answerStep(db, 16, "next answer", "user-2");
      systemStep(db, 17, "unsettled");
      insert.run(18, 132, 3, commandResult("defer", "echo defer", "defer", "unsettled"));
      insert.run(
        19,
        15,
        8,
        Buffer.concat([runField("unsettled"), bytes(20, textField(1, "partial"))]),
      );

      const knownTurnRefs = ["turn-0", "wake-4", "turn-1"].map((nativeTurnKey) =>
        nativeTurnRefSchema.parse({ ...nativeRef, nativeTurnKey }),
      );
      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home, knownTurnRefs });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(
        snapshot.value.turns.map(({ input, items, nativeTurnRef, checkpoint }) => ({
          input: input.map(({ text }) => text),
          items: items.map(({ item }) => (item.type === "agentMessage" ? item.text : item.type)),
          key: nativeTurnRef.nativeTurnKey,
          checkpoint: checkpoint?.checkpointId,
        })),
      ).toEqual([
        {
          input: ["你好"],
          items: ["commandExecution", "你好！👋"],
          key: "turn-0",
          checkpoint: "turn-0",
        },
        {
          input: [],
          items: ["commandExecution", "toolExecution", "定时器已触发"],
          key: "wake-4",
          checkpoint: "wake-4",
        },
        { input: ["next input"], items: ["next answer"], key: "turn-2", checkpoint: "turn-2" },
      ]);
      const foregroundCommand = snapshot.value.turns[0]?.items[0];
      const wakeCommand = snapshot.value.turns[1]?.items[0];
      expect(foregroundCommand).toMatchObject({
        item: { command: "echo foreground", output: "foreground", exitCode: 0 },
        outcome: { status: "succeeded" },
      });
      expect(wakeCommand).toMatchObject({
        item: { command: "echo wake", exitCode: 0 },
        outcome: { status: "succeeded" },
      });
      expect(wakeCommand?.item).not.toHaveProperty("output");
      expect(wakeCommand?.item.itemId).not.toBe(foregroundCommand?.item.itemId);
      expect(
        await readDerivationBoundaries(nativeConversationDbPath(nativeRef.nativeSessionId, home)),
      ).toEqual([
        { idx: 0, checkpointId: "turn-0" },
        { idx: 4, checkpointId: "wake-4" },
        { idx: 14, checkpointId: "turn-1" },
        { idx: 15, checkpointId: "turn-2" },
      ]);
      expect(await opened.value.readSnapshot()).toEqual(snapshot);
    } finally {
      db.close();
    }
  });

  it("keeps chained Plan executions on their original user and autonomous Turns", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      userStep(db, 0, "Plan and implement", "plan");
      planModeSwitch(db, 1, "plan", "execute");
      systemStep(db, 4, "execute", "work_efficiently_reminder");
      checkpointStep(db, 5, { run: "execute" });
      db.prepare("INSERT INTO steps VALUES (6, 132, 3, ?)").run(
        commandResult("work", "pwd", "/example", "execute"),
      );
      planModeSwitch(db, 7, "execute", "plan-again", "enter");
      answerStep(db, 10, "User reply", "plan-again");
      systemStep(db, 11, "wake", "task_notification");
      planModeSwitch(db, 12, "wake", "wake-execute");
      answerStep(db, 15, "Wake reply", "wake-execute");
      userStep(db, 16, "Next prompt", "next");
      answerStep(db, 17, "Next reply", "next");

      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns.map((turn) => turn.checkpoint?.checkpointId)).toEqual([
        "turn-0",
        "wake-11",
        "turn-1",
      ]);
      expect(snapshot.value.turns[0]?.items.map(({ item }) => item)).toMatchObject([
        { toolName: "exit_plan_mode" },
        { type: "contextCompaction", itemId: "checkpoint-5" },
        { type: "commandExecution", output: "/example" },
        { toolName: "enter_plan_mode" },
        { type: "agentMessage", text: "User reply" },
      ]);
      expect(snapshot.value.turns[1]).toMatchObject({
        nativeTurnRef: { nativeTurnKey: "wake-11" },
        input: [],
        items: [{ item: { toolName: "exit_plan_mode" } }, { item: { text: "Wake reply" } }],
      });
    } finally {
      db.close();
    }
  });

  it.each([8, 6, 12, 7])(
    "keeps committed Plan continuation work before a non-final planner (status %i)",
    async (status) => {
      const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
      try {
        userStep(db, 0, "Plan", "plan");
        planModeSwitch(db, 1, "plan", "execute");
        db.prepare("INSERT INTO steps VALUES (4, 132, 3, ?), (5, 15, ?, ?)").run(
          commandResult("work", "pwd", "/example", "execute"),
          status,
          Buffer.concat([runField("execute"), bytes(20, Buffer.alloc(0))]),
        );
        systemStep(db, 6, "wake", "agent_message");
        answerStep(db, 7, "Independent reply", "wake");
        const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
        assert(opened.ok);
        const snapshot = await opened.value.readSnapshot();
        assert(snapshot.ok);
        expect(snapshot.value.turns).toMatchObject([
          {
            nativeTurnRef: { nativeTurnKey: "turn-0" },
            outcome: { status: "unknown" },
            items: [
              { item: { toolName: "exit_plan_mode" }, outcome: { status: "succeeded" } },
              { item: { type: "commandExecution", output: "/example" } },
            ],
          },
          {
            nativeTurnRef: { nativeTurnKey: "wake-6" },
            items: [{ item: { text: "Independent reply" } }],
          },
        ]);
      } finally {
        db.close();
      }
    },
  );

  it("does not derive a checkpoint for an orphaned Plan continuation", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      systemStep(db, 0, "execute", "plan_mode_handoff");
      systemStep(db, 1, "execute", "work_efficiently_reminder");
      answerStep(db, 2, "Unanchored reply", "execute");
      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns).toMatchObject([
        {
          nativeTurnRef: { nativeTurnKey: "replay-0" },
          items: [{ item: { text: "Unanchored reply" } }],
        },
      ]);
      expect(snapshot.value.turns[0]?.checkpoint).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps a committed wake unchanged while a second wake is generating", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      userStep(db, 0, "set two timers", "user");
      answerStep(db, 1, "timers set", "user");
      systemStep(db, 2, "first-wake");
      answerStep(db, 3, "first timer expired", "first-wake");
      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const first = await opened.value.readSnapshot();
      assert(first.ok);
      expect(first.value.turns).toHaveLength(2);

      systemStep(db, 4, "second-wake");
      const payload = Buffer.concat([
        runField("second-wake"),
        bytes(20, textField(1, "second timer expired")),
      ]);
      db.prepare("INSERT INTO steps VALUES (5, 15, 8, ?)").run(payload);
      expect(await opened.value.readSnapshot()).toEqual(first);

      db.exec("UPDATE steps SET status = 3 WHERE idx = 5");
      const both = await opened.value.readSnapshot();
      assert(both.ok);
      expect(both.value.turns.slice(0, 2)).toEqual(first.value.turns);
      expect(both.value.turns.slice(2)).toMatchObject([
        {
          nativeTurnRef: { nativeTurnKey: "wake-4" },
          input: [],
          items: [{ item: { type: "agentMessage", text: "second timer expired" } }],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps in-prompt wakes inside their user Turn while still splitting out-of-prompt wakes", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      db.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
      userStep(db, 0, "run background task", "prompt-1");
      stamp(0, 1_000_050);
      answerStep(db, 1, "WAITING_IN_BG", "prompt-1");
      stamp(1, 1_005_000);
      systemStep(db, 2, "in-prompt-wake", "task_notification");
      stamp(2, 1_015_000);
      checkpointStep(db, 3, { status: 3, run: "in-prompt-wake", summary: "Compacted" });
      db.prepare(
        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (4, 132, 3, ?)",
      ).run(commandResult("wake-cmd", "echo ok", "ok", "in-prompt-wake"));
      answerStep(db, 5, "WAKE_RESULT: AGY_WAKE_DONE", "in-prompt-wake");
      stamp(5, 1_015_500);
      systemStep(db, 6, "idle-daemon-wake", "task_notification");
      stamp(6, 1_030_000);
      answerStep(db, 7, "DAEMON_DONE", "idle-daemon-wake");
      stamp(7, 1_030_100);

      const promptWindows = [{ submittedAtMs: 1_000_000, returnedAtMs: 1_016_000 }];
      await savePromptWindows(nativeRef.nativeSessionId, promptWindows, {
        HOME: home,
        USERPROFILE: home,
      });

      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(
        snapshot.value.turns.map(({ nativeTurnRef, checkpoint, input, items }) => ({
          key: nativeTurnRef.nativeTurnKey,
          checkpoint: checkpoint?.checkpointId,
          input: input.map(({ text }) => text),
          items: items.map(({ item }) => (item.type === "agentMessage" ? item.text : item.type)),
        })),
      ).toEqual([
        {
          key: "turn-0",
          checkpoint: "turn-0",
          input: ["run background task"],
          items: [
            "WAITING_IN_BG",
            "contextCompaction",
            "commandExecution",
            "WAKE_RESULT: AGY_WAKE_DONE",
          ],
        },
        {
          key: "wake-6",
          checkpoint: "wake-6",
          input: [],
          items: ["DAEMON_DONE"],
        },
      ]);
      expect(
        await readDerivationBoundaries(nativeConversationDbPath(nativeRef.nativeSessionId, home), {
          promptWindows,
        }),
      ).toEqual([
        { idx: 0, checkpointId: "turn-0" },
        { idx: 6, checkpointId: "wake-6" },
      ]);
    } finally {
      db.close();
    }
  });

  it("routes in-prompt wakes and live compactions back to their user Turn across late wakes, candidates, and empty user runs", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      userStep(db, 0, "first", "p0");
      answerStep(db, 1, "first reply", "p0");
      userStep(db, 2, "second", "p1");
      // Independent wake started between prompts (900) but committed after turn-1's USER_INPUT.
      systemStep(db, 3, "idle", "task_notification");
      answerStep(db, 4, "IDLE_REPLY", "idle");
      // First in-prompt wake (1200) + succeeded compaction + Plan switch + second in-prompt wake (1400) + failed compaction.
      systemStep(db, 5, "w1", "task_notification");
      checkpointStep(db, 6, { status: 3, run: "w1", summary: "Compacted 1" });
      answerStep(db, 7, "WAKE_RESULT", "w1");
      planModeSwitch(db, 8, "w1", "plan");
      systemStep(db, 11, "w2", "task_notification");
      checkpointStep(db, 12, { status: 7, run: "w2", error: "Compaction failed" });
      answerStep(db, 13, "SECOND_WAKE", "w2");
      // Turn 2: empty user run + unsettled candidate before an in-prompt wake with compaction.
      userStep(db, 14, "third", "");
      systemStep(db, 15, "unsettled-orphan", "task_notification");
      systemStep(db, 16, "w3", "task_notification");
      checkpointStep(db, 17, { status: 3, run: "w3", summary: "Compacted 3" });
      answerStep(db, 18, "THIRD_WAKE", "w3");
      db.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
      stamp(3, 900);
      stamp(5, 1_200);
      stamp(11, 1_400);
      stamp(16, 2_500);

      const promptWindows = [
        { submittedAtMs: 100, returnedAtMs: 500 },
        { submittedAtMs: 1_000, returnedAtMs: 2_000 },
        { submittedAtMs: 2_100, returnedAtMs: 3_000 },
      ];
      await savePromptWindows(nativeRef.nativeSessionId, promptWindows, {
        HOME: home,
        USERPROFILE: home,
      });

      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(
        snapshot.value.turns.map(({ nativeTurnRef, input, items }) => ({
          key: nativeTurnRef.nativeTurnKey,
          input: input.map(({ text }) => text),
          items: items.map(({ item }) => (item.type === "agentMessage" ? item.text : item.type)),
        })),
      ).toEqual([
        { key: "turn-0", input: ["first"], items: ["first reply"] },
        {
          key: "turn-1",
          input: ["second"],
          items: [
            "contextCompaction",
            "WAKE_RESULT",
            "toolExecution",
            "contextCompaction",
            "SECOND_WAKE",
          ],
        },
        { key: "wake-3", input: [], items: ["IDLE_REPLY"] },
        { key: "turn-2", input: ["third"], items: ["contextCompaction", "THIRD_WAKE"] },
      ]);
      const dbPath = nativeConversationDbPath(nativeRef.nativeSessionId, home);
      expect(await readDerivationBoundaries(dbPath, { promptWindows })).toEqual([
        { idx: 0, checkpointId: "turn-0" },
        { idx: 2, checkpointId: "turn-1" },
        { idx: 3, checkpointId: "wake-3" },
        { idx: 14, checkpointId: "turn-2" },
      ]);
      expect(
        await readNativeTurnCompactions(dbPath, 1, (createdAtMs) =>
          isTimestampInPromptWindows(createdAtMs, promptWindows.slice(1, 2)),
        ),
      ).toEqual([
        { type: "history.compaction", stepIndex: 6, status: "succeeded" },
        {
          type: "history.compaction",
          stepIndex: 12,
          status: "failed",
          error: "Compaction failed",
        },
      ]);
      expect(
        await readNativeTurnCompactions(dbPath, 13, (createdAtMs) =>
          isTimestampInPromptWindows(createdAtMs, promptWindows.slice(2, 3)),
        ),
      ).toEqual([{ type: "history.compaction", stepIndex: 17, status: "succeeded" }]);
    } finally {
      db.close();
    }
  });

  it("keeps background Plan continuation compactions out of the foreground Turn even when stamped inside the prompt window", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      userStep(db, 0, "foreground", "p");
      systemStep(db, 1, "idle", "task_notification");
      answerStep(db, 2, "idle reply", "idle");
      planModeSwitch(db, 3, "idle", "idle-plan");
      checkpointStep(db, 6, { status: 3, run: "idle-plan", summary: "Background compact" });
      checkpointStep(db, 7, { status: 7, run: "idle-plan", error: "Background failure" });
      answerStep(db, 8, "idle plan reply", "idle-plan");
      db.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
      stamp(1, 900);
      // Plan handoff timestamp falls inside the foreground prompt window [1000, 2000],
      // but it continues the background `idle` run and must not steal foreground ownership.
      stamp(5, 1_200);

      const promptWindow = { submittedAtMs: 1_000, returnedAtMs: 2_000 };
      const dbPath = nativeConversationDbPath(nativeRef.nativeSessionId, home);
      expect(
        await readNativeTurnCompactions(dbPath, -1, (createdAtMs) =>
          isTimestampInPromptWindows(createdAtMs, [promptWindow]),
        ),
      ).toEqual([]);

      await savePromptWindows(nativeRef.nativeSessionId, [promptWindow], {
        HOME: home,
        USERPROFILE: home,
      });
      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns[0]?.items).toEqual([]);
      expect(snapshot.value.turns[1]?.nativeTurnRef.nativeTurnKey).toBe("wake-1");
      expect(
        snapshot.value.turns[1]?.items.filter(({ item }) => item.type === "contextCompaction"),
      ).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("aligns readNativeTurnCompactions Plan handoff ownership with decodeNativeHistory across interleaved runs", async () => {
    const promptWindow = { submittedAtMs: 1_000, returnedAtMs: 2_000 };
    const inWindow = (createdAtMs: number | undefined) =>
      isTimestampInPromptWindows(createdAtMs, [promptWindow]);

    // A: Foreground in-prompt wake initiates Plan switch after an independent wake's SYSTEM_MESSAGE.
    const fgRef = nativeSessionRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: "compaction-plan-interleaved-fg",
      formatVersion: 1,
    });
    const dbA = await createNativeHistoryDatabase(home, fgRef.nativeSessionId);
    try {
      const stamp = (idx: number, ms: number) => {
        dbA
          .prepare("UPDATE steps SET metadata = ? WHERE idx = ?")
          .run(bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)), idx);
      };
      userStep(dbA, 0, "foreground", "p");
      systemStep(dbA, 1, "w", "task_notification");
      systemStep(dbA, 2, "idle", "task_notification");
      answerStep(dbA, 3, "IDLE", "idle");
      planModeSwitch(dbA, 4, "w", "w-plan");
      checkpointStep(dbA, 7, { status: 3, run: "w-plan", summary: "FG Plan Compact" });
      answerStep(dbA, 8, "USER_PLAN_RESULT", "w-plan");
      dbA.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
      stamp(1, 1_200);
      stamp(2, 900);
      stamp(6, 1_500);

      expect(
        await readNativeTurnCompactions(
          nativeConversationDbPath(fgRef.nativeSessionId, home),
          -1,
          inWindow,
        ),
      ).toEqual([{ type: "history.compaction", stepIndex: 7, status: "succeeded" }]);
    } finally {
      dbA.close();
    }

    // B: Background wake initiates Plan switch after a foreground in-prompt wake's SYSTEM_MESSAGE.
    const bgRef = nativeSessionRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: "compaction-plan-interleaved-bg",
      formatVersion: 1,
    });
    const dbB = await createNativeHistoryDatabase(home, bgRef.nativeSessionId);
    try {
      const stamp = (idx: number, ms: number) => {
        dbB
          .prepare("UPDATE steps SET metadata = ? WHERE idx = ?")
          .run(bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)), idx);
      };
      userStep(dbB, 0, "foreground", "p");
      systemStep(dbB, 1, "idle", "task_notification");
      systemStep(dbB, 2, "w", "task_notification");
      planModeSwitch(dbB, 3, "idle", "idle-plan");
      checkpointStep(dbB, 6, { status: 7, run: "idle-plan", error: "BACKGROUND_ONLY_FAILURE" });
      answerStep(dbB, 7, "IDLE_PLAN", "idle-plan");
      answerStep(dbB, 8, "FOREGROUND", "w");
      dbB.exec("ALTER TABLE steps ADD COLUMN metadata BLOB");
      stamp(1, 900);
      stamp(2, 1_200);
      stamp(5, 1_500);

      expect(
        await readNativeTurnCompactions(
          nativeConversationDbPath(bgRef.nativeSessionId, home),
          -1,
          inWindow,
        ),
      ).toEqual([]);
    } finally {
      dbB.close();
    }
  });

  it("preserves all prompt windows across concurrent multi-process writers", async () => {
    const execFileAsync = promisify(execFile);
    const moduleUrl = pathToFileURL(
      path.resolve(import.meta.dirname, "../src/prompt-windows.ts"),
    ).href;
    const sessionId = "concurrent-writers";
    const env = { ...process.env, HOME: home, USERPROFILE: home, CODEXHOST_DATA_DIR: home };
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `import { savePromptWindows } from ${JSON.stringify(moduleUrl)};
             await savePromptWindows(${JSON.stringify(sessionId)}, [{ submittedAtMs: ${1_000 + index * 100}, returnedAtMs: ${1_050 + index * 100} }], process.env);`,
          ],
          { env },
        ),
      ),
    );
    expect(await readPromptWindows(sessionId, env)).toEqual(
      Array.from({ length: 6 }, (_, index) => ({
        submittedAtMs: 1_000 + index * 100,
        returnedAtMs: 1_050 + index * 100,
      })),
    );
  });

  it("reads committed WAL steps but not an uncommitted or still-generating reply", async () => {
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
      userStep(db, 0, "Question in WAL");
      db.prepare("INSERT INTO steps VALUES (1, 15, 8, ?)").run(
        bytes(20, textField(3, "Generating")),
      );
      db.exec("BEGIN IMMEDIATE");
      answerStep(db, 2, "Uncommitted answer");
      const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
      assert(opened.ok);
      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns).toMatchObject([
        {
          input: [{ type: "text", text: "Question in WAL" }],
          items: [],
          outcome: { status: "unknown" },
        },
      ]);
      db.exec("COMMIT");
      const settled = await opened.value.readSnapshot();
      assert(settled.ok);
      expect(settled.value.turns).toMatchObject([
        {
          nativeTurnRef: snapshot.value.turns[0]?.nativeTurnRef,
          items: [{ item: { type: "agentMessage", text: "Uncommitted answer" } }],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    "missing",
    "unknown schema version",
    "unknown step payload",
    "invalid protobuf",
    "invalid tool body",
  ])("reports history unavailable for %s, without ACP or transcript fallback", async (failure) => {
    if (failure !== "missing") {
      const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
      try {
        if (failure === "unknown schema version") db.exec("PRAGMA user_version = 2");
        else
          db.prepare("INSERT INTO steps VALUES (0, ?, 3, ?)").run(
            failure === "invalid tool body" ? 132 : 15,
            failure === "unknown step payload"
              ? textField(99, "Unrecognized")
              : failure === "invalid tool body"
                ? bytes(140, Buffer.from([0xff]))
                : Buffer.from([0xff]),
          );
      } finally {
        db.close();
      }
    }
    const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home });
    assert(opened.ok);
    expect(await opened.value.readSnapshot()).toEqual({
      ok: false,
      error: {
        code: "nativeFailure",
        message: "Antigravity history unavailable",
        retryable: false,
      },
    });
  });
});
