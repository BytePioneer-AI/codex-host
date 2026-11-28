import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessSession, ResumeSessionInput } from "@codexhost/harness-adapter";
import { harnessIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forkAntigravitySession,
  minimalTrajectoryMetadataBlob,
  nativeBrainDirPath,
  nativeConversationDbPath,
} from "../src/fork.js";
import { readNativeTurnCount } from "../src/native-turn-boundaries.js";
import { readNativeHistory } from "../src/native-replay.js";
import {
  promptWindowsDirectory,
  readPromptWindows,
  savePromptWindows,
} from "../src/prompt-windows.js";
import { rollbackAntigravityLastTurn } from "../src/rollback.js";
import {
  answerStep,
  planModeSwitch,
  runField,
  systemStep,
  textField,
  userStep,
} from "../../../../tests/fixtures/antigravity/native-history-fixture.js";
import {
  bytes,
  integer,
  nanoseconds,
  varint,
} from "../../../../tests/fixtures/antigravity/native-timing-fixture.js";

const metadataRows = {
  gen_metadata: [[2], [5], [6, 8]].map((steps) => bytes(2, Buffer.concat(steps.map(varint)))),
  executor_metadata: [2, 5, 8].map((step) => integer(3, step)),
  parent_references: [2, 5, 8].map((step) =>
    Buffer.concat([textField(1, `ancestor-${step}`), integer(2, step)]),
  ),
  battle_mode_infos: (
    [
      [0, 2],
      [3, 5],
      [5, 8],
    ] as const
  ).map(([start, end]) => Buffer.concat([integer(3, start), integer(4, end), integer(9, 1)])),
};
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-fork-"));
  homes.push(home);
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "antigravity",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
    locator: { executionPolicy: "unattended-full-access" },
  });
  const file = nativeConversationDbPath(sourceRef.nativeSessionId, home);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE battle_mode_infos (idx INTEGER PRIMARY KEY, data BLOB)",
  );
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(
    randomUUID(),
    sourceRef.nativeSessionId,
  );
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
    minimalTrajectoryMetadataBlob(sourceRef.nativeSessionId),
  );
  for (let turn = 0; turn < 3; turn++)
    db.prepare("INSERT INTO steps VALUES (?,14), (?,15)").run(turn * 3, turn * 3 + 2);
  for (const [table, rows] of Object.entries(metadataRows)) {
    const insert = db.prepare(`INSERT INTO ${table} (idx, data) VALUES (?, ?)`);
    rows.forEach((data, idx) => insert.run(idx, data));
  }
  db.exec("UPDATE gen_metadata SET size = length(data)");
  db.close();
  const brain = nativeBrainDirPath(sourceRef.nativeSessionId, home);
  await mkdir(path.join(brain, ".system_generated"), { recursive: true });
  await writeFile(path.join(brain, "artifact.md"), "artifact");
  await writeFile(path.join(brain, ".system_generated", "stale"), "not copied");
  const openSession = vi.fn(async (input: ResumeSessionInput) => ({
    ok: true as const,
    value: { initialState: { nativeRef: input.nativeRef } } as HarnessSession,
  }));
  const options = {
    harnessId: harnessIdSchema.parse("antigravity"),
    adapterEnvironment: { HOME: home, USERPROFILE: home },
    openSession,
  };
  return { home, sourceRef, file, options, openSession };
}
describe("native SQLite Fork", () => {
  it.each([
    [0, false],
    [1, false],
    [2, false],
    [0, true],
  ] as const)(
    "retains only the prefix through turn-%i and supports another cwd (live: %s)",
    async (index, live) => {
      const f = await fixture();
      const halfWritten = path.join(
        nativeBrainDirPath(f.sourceRef.nativeSessionId, f.home),
        "partial.json",
      );
      if (live) {
        const db = new DatabaseSync(f.file);
        db.exec("PRAGMA journal_mode=WAL");
        db.close();
        await writeFile(halfWritten, '{"state":');
      }
      const before = await readFile(f.file);
      const result = await forkAntigravitySession({
        ...f.options,
        ...(live ? { sourceSession: { isActive: true, activeForkTurnIndex: () => 2 } } : {}),
        input: {
          kind: "fork",
          sourceRef: f.sourceRef,
          checkpoint: { ...f.sourceRef, checkpointId: `turn-${index}` },
          cwd: "/another/workspace",
          environment: { CODEXHOST_THREAD_ID: "derived" },
        },
      });
      expect(result.ok).toBe(true);
      const opened = f.openSession.mock.calls[0]?.[0];
      assert(opened);
      const id = opened.nativeRef.nativeSessionId;
      expect(id).not.toBe(f.sourceRef.nativeSessionId);
      expect(opened).toMatchObject({
        kind: "resume",
        cwd: "/another/workspace",
        environment: { CODEXHOST_THREAD_ID: "derived" },
        nativeRef: { locator: { executionPolicy: "unattended-full-access" } },
      });
      const derivedFile = nativeConversationDbPath(id, f.home);
      expect(await readNativeTurnCount(derivedFile)).toBe(index + 1);
      const derived = new DatabaseSync(derivedFile, { readOnly: true });
      try {
        for (const [table, rows] of Object.entries(metadataRows)) {
          expect
            .soft(derived.prepare(`SELECT idx, data FROM ${table} ORDER BY idx`).all(), table)
            .toEqual(
              rows.slice(0, index + 1).map((data, idx) => ({ idx, data: new Uint8Array(data) })),
            );
        }
      } finally {
        derived.close();
      }
      expect(await readFile(f.file)).toEqual(before);
      if (live) {
        await expect(access(nativeBrainDirPath(id, f.home))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(halfWritten, "utf8")).toBe('{"state":');
      } else {
        expect(
          await readFile(path.join(nativeBrainDirPath(id, f.home), "artifact.md"), "utf8"),
        ).toBe("artifact");
        expect(await readdir(nativeBrainDirPath(id, f.home))).toEqual(["artifact.md"]);
      }
    },
  );
  it("forks on either side of a wake and rolls it back without losing the preceding user Turn", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)",
      );
      userStep(db, 0, "hello", "prompt");
      planModeSwitch(db, 1, "prompt", "execute");
      answerStep(db, 4, "hello there", "execute");
      systemStep(db, 5, "wake", "task_notification");
      answerStep(db, 6, "wake answer", "wake");
    } finally {
      db.close();
    }
    const prefix = (id: string) => readNativeHistory(id, f.home).then(({ events }) => events);
    const source = await prefix(f.sourceRef.nativeSessionId);
    const userPrefix = source.slice(
      0,
      source.findIndex((event) => event.type === "history.autonomous"),
    );
    for (const checkpointId of ["turn-0", "wake-5"]) {
      const result = await forkAntigravitySession({
        ...f.options,
        input: {
          kind: "fork",
          cwd: f.home,
          sourceRef: f.sourceRef,
          checkpoint: { ...f.sourceRef, checkpointId },
        },
      });
      assert(result.ok && result.value.initialState.nativeRef);
      const forked = await prefix(result.value.initialState.nativeRef.nativeSessionId);
      expect(forked).toEqual(checkpointId === "turn-0" ? userPrefix : source);
      expect(forked).toContainEqual({ type: "agent.text", text: "hello there" });
    }
    expect(
      await forkAntigravitySession({
        ...f.options,
        input: {
          kind: "fork",
          cwd: f.home,
          sourceRef: f.sourceRef,
          checkpoint: { ...f.sourceRef, checkpointId: "wake-3" },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    const rolledBack = await rollbackAntigravityLastTurn({
      ...f.options,
      input: { kind: "rollbackLastTurn", cwd: f.home, sourceRef: f.sourceRef },
    });
    assert(rolledBack.ok && rolledBack.value.initialState.nativeRef);
    expect(await prefix(rolledBack.value.initialState.nativeRef.nativeSessionId)).toEqual(
      userPrefix,
    );
    expect(await prefix(f.sourceRef.nativeSessionId)).toEqual(source);
  });

  it("preserves in-prompt wake continuations on Fork and removes them cleanly on Rollback", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
      );
      userStep(db, 0, "run background", "p1");
      stamp(0, 1_000_050);
      answerStep(db, 1, "WAITING_IN_BG", "p1");
      stamp(1, 1_005_000);
      systemStep(db, 2, "in-prompt-wake", "task_notification");
      stamp(2, 1_015_000);
      answerStep(db, 3, "WAKE_RESULT: AGY_WAKE_DONE", "in-prompt-wake");
      stamp(3, 1_015_100);
      userStep(db, 4, "follow up", "p2");
      stamp(4, 2_000_050);
      answerStep(db, 5, "done", "p2");
      stamp(5, 2_001_000);
    } finally {
      db.close();
    }
    const turn0Window = { submittedAtMs: 1_000_000, returnedAtMs: 1_016_000 };
    const turn1Window = { submittedAtMs: 2_000_000, returnedAtMs: 2_002_000 };
    await savePromptWindows(
      f.sourceRef.nativeSessionId,
      [turn0Window, turn1Window],
      f.options.adapterEnvironment,
    );

    const forked = await forkAntigravitySession({
      ...f.options,
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
      },
    });
    assert(forked.ok && forked.value.initialState.nativeRef);
    const forkedId = forked.value.initialState.nativeRef.nativeSessionId;
    const forkedWindows = await readPromptWindows(forkedId, f.options.adapterEnvironment);
    expect(forkedWindows).toEqual([turn0Window]);
    const forkedHistory = await readNativeHistory(forkedId, f.home, {
      promptWindows: forkedWindows,
    });
    expect(forkedHistory.events).toEqual([
      { type: "user.text", text: "run background", nativeTurnIndex: 0 },
      { type: "agent.text", text: "WAITING_IN_BG" },
      { type: "agent.text", text: "\n\nWAKE_RESULT: AGY_WAKE_DONE" },
    ]);

    // Rolling back the single Turn (containing an in-prompt wake) removes all its steps cleanly.
    const rolledBack = await rollbackAntigravityLastTurn({
      ...f.options,
      input: {
        kind: "rollbackLastTurn",
        cwd: f.home,
        sourceRef: forked.value.initialState.nativeRef,
      },
    });
    assert(rolledBack.ok && rolledBack.value.initialState.nativeRef);
    const rolledBackId = rolledBack.value.initialState.nativeRef.nativeSessionId;
    expect(await readNativeTurnCount(nativeConversationDbPath(rolledBackId, f.home))).toBe(0);
    expect(await readPromptWindows(rolledBackId, f.options.adapterEnvironment)).toEqual([]);

    // Failed derivation must clean up derived prompt-windows metadata without touching source.
    const failed = await forkAntigravitySession({
      ...f.options,
      openSession: vi.fn(async () => ({
        ok: false as const,
        error: { code: "authenticationRequired" as const, message: "Login", retryable: false },
      })),
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
      },
    });
    expect(failed.ok).toBe(false);
    expect((await readdir(promptWindowsDirectory(f.options.adapterEnvironment))).sort()).toEqual(
      [`${f.sourceRef.nativeSessionId}.jsonl`, `${forkedId}.jsonl`].sort(),
    );

    // Auxiliary prompt-window storage failures must degrade instead of blocking Fork, Rollback,
    // or derived-file cleanup when openSession fails.
    const blockedEnv = {
      ...f.options.adapterEnvironment,
      CODEXHOST_DATA_DIR: path.join(f.home, "blocked-data"),
    };
    await mkdir(blockedEnv.CODEXHOST_DATA_DIR, { recursive: true });
    await writeFile(promptWindowsDirectory(blockedEnv), "not-a-directory");
    const degradedFork = await forkAntigravitySession({
      ...f.options,
      adapterEnvironment: blockedEnv,
      sourcePromptWindows: [turn0Window],
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
      },
    });
    assert(degradedFork.ok && degradedFork.value.initialState.nativeRef);
    const degradedForkId = degradedFork.value.initialState.nativeRef.nativeSessionId;

    const degradedRollback = await rollbackAntigravityLastTurn({
      ...f.options,
      adapterEnvironment: blockedEnv,
      sourcePromptWindows: [turn0Window],
      input: {
        kind: "rollbackLastTurn",
        cwd: f.home,
        sourceRef: degradedFork.value.initialState.nativeRef,
      },
    });
    assert(degradedRollback.ok && degradedRollback.value.initialState.nativeRef);
    const degradedRollbackId = degradedRollback.value.initialState.nativeRef.nativeSessionId;
    expect(await readNativeTurnCount(nativeConversationDbPath(degradedRollbackId, f.home))).toBe(0);

    const blockedOpenFail = await forkAntigravitySession({
      ...f.options,
      adapterEnvironment: blockedEnv,
      sourcePromptWindows: [turn0Window],
      openSession: vi.fn(async () => ({
        ok: false as const,
        error: { code: "authenticationRequired" as const, message: "Login", retryable: false },
      })),
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
      },
    });
    expect(blockedOpenFail).toEqual({
      ok: false,
      error: { code: "authenticationRequired", message: "Login", retryable: false },
    });
    expect(
      (await readdir(path.dirname(f.file))).filter((name) => name.endsWith(".db")).sort(),
    ).toEqual(
      [
        `${f.sourceRef.nativeSessionId}.db`,
        `${forkedId}.db`,
        `${rolledBackId}.db`,
        `${degradedForkId}.db`,
        `${degradedRollbackId}.db`,
      ].sort(),
    );
  });

  it("rejects an interleaved native cutoff instead of dropping a retained wake continuation", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
      );
      userStep(db, 0, "first", "p0");
      answerStep(db, 1, "first reply", "p0");
      userStep(db, 2, "second", "p1");
      systemStep(db, 3, "idle", "task_notification");
      answerStep(db, 4, "IDLE_REPLY", "idle");
      systemStep(db, 5, "in-prompt", "task_notification");
      answerStep(db, 6, "WAKE_RESULT", "in-prompt");
      stamp(3, 900);
      stamp(5, 1_200);
    } finally {
      db.close();
    }
    const promptWindows = [
      { submittedAtMs: 100, returnedAtMs: 500 },
      { submittedAtMs: 1_000, returnedAtMs: 2_000 },
    ];
    await savePromptWindows(
      f.sourceRef.nativeSessionId,
      promptWindows,
      f.options.adapterEnvironment,
    );
    const before = await readFile(f.file);

    const input = {
      kind: "fork" as const,
      cwd: f.home,
      sourceRef: f.sourceRef,
      checkpoint: { ...f.sourceRef, checkpointId: "turn-1" },
    };
    expect.soft(await forkAntigravitySession({ ...f.options, input })).toMatchObject({
      ok: false,
      error: { code: "checkpointNotFound" },
    });
    expect
      .soft(
        await rollbackAntigravityLastTurn({
          ...f.options,
          input: { kind: "rollbackLastTurn", cwd: f.home, sourceRef: f.sourceRef },
        }),
      )
      .toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(f.file))).toEqual([path.basename(f.file)]);
    expect(await readFile(f.file)).toEqual(before);

    const forked = await forkAntigravitySession({
      ...f.options,
      input: { ...input, checkpoint: { ...f.sourceRef, checkpointId: "wake-3" } },
    });
    assert(forked.ok && forked.value.initialState.nativeRef);
    const forkedId = forked.value.initialState.nativeRef.nativeSessionId;
    const inheritedWindows = await readPromptWindows(forkedId, f.options.adapterEnvironment);
    const history = await readNativeHistory(forkedId, f.home, { promptWindows: inheritedWindows });
    expect(history.events).toEqual([
      { type: "user.text", text: "first", nativeTurnIndex: 0 },
      { type: "agent.text", text: "first reply" },
      { type: "user.text", text: "second", nativeTurnIndex: 1 },
      { type: "agent.text", text: "WAKE_RESULT" },
      { type: "history.autonomous", stepIndex: 3, createdAtMs: 900 },
      { type: "agent.text", text: "IDLE_REPLY" },
    ]);
  });

  it("rejects Fork when an independent wake splits an in-prompt wake system step from its retained tool and answer", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    const call = Buffer.concat([
      textField(1, "c1"),
      textField(2, "view_file"),
      textField(3, JSON.stringify({ path: "notes.md" })),
    ]);
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
      );
      userStep(db, 0, "first", "p0");
      systemStep(db, 1, "wake-a", "task_notification");
      answerStep(db, 2, "WAKE_A", "wake-a");
      systemStep(db, 3, "in-prompt", "task_notification");
      db.prepare(
        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (4, 15, 3, ?)",
      ).run(Buffer.concat([runField("in-prompt"), bytes(20, bytes(7, call))]));
      systemStep(db, 5, "wake-b", "task_notification");
      db.prepare(
        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (6, 132, 3, ?)",
      ).run(
        Buffer.concat([
          bytes(5, Buffer.concat([bytes(4, textField(1, "c1")), textField(12, "in-prompt")])),
          bytes(140, bytes(2, textField(1, "tool output"))),
        ]),
      );
      answerStep(db, 7, "IN_PROMPT_ANSWER", "in-prompt");
      answerStep(db, 8, "WAKE_B", "wake-b");
      stamp(1, 500);
      stamp(3, 1_200);
      stamp(5, 2_500);
    } finally {
      db.close();
    }
    await savePromptWindows(
      f.sourceRef.nativeSessionId,
      [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }],
      f.options.adapterEnvironment,
    );
    const before = await readFile(f.file);

    const rejected = await forkAntigravitySession({
      ...f.options,
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "wake-1" },
      },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(f.file))).toEqual([path.basename(f.file)]);
    expect(await readFile(f.file)).toEqual(before);

    const forked = await forkAntigravitySession({
      ...f.options,
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "wake-5" },
      },
    });
    assert(forked.ok && forked.value.initialState.nativeRef);
    const forkedId = forked.value.initialState.nativeRef.nativeSessionId;
    const inheritedWindows = await readPromptWindows(forkedId, f.options.adapterEnvironment);
    const history = await readNativeHistory(forkedId, f.home, { promptWindows: inheritedWindows });
    expect(history.events).toMatchObject([
      { type: "user.text", text: "first", nativeTurnIndex: 0 },
      { type: "tool.call", toolCallId: "c1", name: "view_file" },
      { type: "tool.update", toolCallId: "c1", status: "completed", rawOutput: "tool output" },
      { type: "agent.text", text: "IN_PROMPT_ANSWER" },
      { type: "history.autonomous", stepIndex: 1, createdAtMs: 500 },
      { type: "agent.text", text: "WAKE_A" },
      { type: "history.autonomous", stepIndex: 5, createdAtMs: 2_500 },
      { type: "agent.text", text: "WAKE_B" },
    ]);
  });

  it("rejects Fork to turn-0 and Rollback when an independent wake splits an in-prompt wake without a prior wake", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
      );
      userStep(db, 0, "first", "p0");
      systemStep(db, 1, "in-prompt", "task_notification");
      systemStep(db, 2, "wake-b", "task_notification");
      answerStep(db, 3, "IN_PROMPT_ANSWER", "in-prompt");
      answerStep(db, 4, "WAKE_B", "wake-b");
      stamp(1, 1_200);
      stamp(2, 2_500);
    } finally {
      db.close();
    }
    await savePromptWindows(
      f.sourceRef.nativeSessionId,
      [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }],
      f.options.adapterEnvironment,
    );
    const before = await readFile(f.file);

    expect
      .soft(
        await forkAntigravitySession({
          ...f.options,
          input: {
            kind: "fork",
            cwd: f.home,
            sourceRef: f.sourceRef,
            checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
          },
        }),
      )
      .toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect
      .soft(
        await rollbackAntigravityLastTurn({
          ...f.options,
          input: { kind: "rollbackLastTurn", cwd: f.home, sourceRef: f.sourceRef },
        }),
      )
      .toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(f.file))).toEqual([path.basename(f.file)]);
    expect(await readFile(f.file)).toEqual(before);

    const forked = await forkAntigravitySession({
      ...f.options,
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "wake-2" },
      },
    });
    assert(forked.ok && forked.value.initialState.nativeRef);
    const forkedId = forked.value.initialState.nativeRef.nativeSessionId;
    const inheritedWindows = await readPromptWindows(forkedId, f.options.adapterEnvironment);
    const history = await readNativeHistory(forkedId, f.home, { promptWindows: inheritedWindows });
    expect(history.events).toEqual([
      { type: "user.text", text: "first", nativeTurnIndex: 0 },
      { type: "agent.text", text: "IN_PROMPT_ANSWER" },
      { type: "history.autonomous", stepIndex: 2, createdAtMs: 2_500 },
      { type: "agent.text", text: "WAKE_B" },
    ]);
  });

  it("keeps in-prompt tool and answer steps in the user Turn and rejects unsafe cuts when an independent wake settles in between", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.file);
    const stamp = (idx: number, ms: number) => {
      db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
        bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
        idx,
      );
    };
    try {
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
      );
      userStep(db, 0, "first", "p0");
      systemStep(db, 1, "in-prompt", "task_notification");
      systemStep(db, 2, "wake-b", "task_notification");
      answerStep(db, 3, "WAKE_B", "wake-b");
      const call = Buffer.concat([
        textField(1, "c-interleaved"),
        textField(2, "view_file"),
        textField(3, JSON.stringify({ path: "notes.md" })),
      ]);
      db.prepare(
        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (4, 15, 3, ?)",
      ).run(Buffer.concat([runField("in-prompt"), bytes(20, bytes(7, call))]));
      db.prepare(
        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (5, 132, 3, ?)",
      ).run(
        Buffer.concat([
          bytes(
            5,
            Buffer.concat([bytes(4, textField(1, "c-interleaved")), textField(12, "in-prompt")]),
          ),
          bytes(140, bytes(2, textField(1, "tool output"))),
        ]),
      );
      answerStep(db, 6, "IN_PROMPT_LATE_ANSWER", "in-prompt");
      stamp(1, 1_200);
      stamp(2, 2_500);
    } finally {
      db.close();
    }
    await savePromptWindows(
      f.sourceRef.nativeSessionId,
      [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }],
      f.options.adapterEnvironment,
    );
    const before = await readFile(f.file);

    expect
      .soft(
        await forkAntigravitySession({
          ...f.options,
          input: {
            kind: "fork",
            cwd: f.home,
            sourceRef: f.sourceRef,
            checkpoint: { ...f.sourceRef, checkpointId: "turn-0" },
          },
        }),
      )
      .toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect
      .soft(
        await rollbackAntigravityLastTurn({
          ...f.options,
          input: { kind: "rollbackLastTurn", cwd: f.home, sourceRef: f.sourceRef },
        }),
      )
      .toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readFile(f.file)).toEqual(before);

    const forked = await forkAntigravitySession({
      ...f.options,
      input: {
        kind: "fork",
        cwd: f.home,
        sourceRef: f.sourceRef,
        checkpoint: { ...f.sourceRef, checkpointId: "wake-2" },
      },
    });
    assert(forked.ok && forked.value.initialState.nativeRef);
    const forkedId = forked.value.initialState.nativeRef.nativeSessionId;
    const inheritedWindows = await readPromptWindows(forkedId, f.options.adapterEnvironment);
    const history = await readNativeHistory(forkedId, f.home, { promptWindows: inheritedWindows });
    expect(history.events).toMatchObject([
      { type: "user.text", text: "first", nativeTurnIndex: 0 },
      { type: "tool.call", toolCallId: "c-interleaved", name: "view_file" },
      {
        type: "tool.update",
        toolCallId: "c-interleaved",
        status: "completed",
        rawOutput: "tool output",
      },
      { type: "agent.text", text: "IN_PROMPT_LATE_ANSWER" },
      { type: "history.autonomous", stepIndex: 2, createdAtMs: 2_500 },
      { type: "agent.text", text: "WAKE_B" },
    ]);
  });

  it("attributes id-only in-prompt tool results, late foreground replies, and Plan handoffs across intervening wakes and rejects unsafe cuts", async () => {
    // 1. R1: id-only tool result (missing execution_id) separated by an independent wake.
    const r1 = await fixture();
    {
      const db = new DatabaseSync(r1.file);
      const stamp = (idx: number, ms: number) => {
        db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
          bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
          idx,
        );
      };
      try {
        db.exec(
          "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
        );
        userStep(db, 0, "first", "p0");
        systemStep(db, 1, "in-prompt", "task_notification");
        const call = Buffer.concat([textField(1, "read"), textField(2, "view_file")]);
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 15, 3, ?)",
        ).run(Buffer.concat([runField("in-prompt"), bytes(20, bytes(7, call))]));
        systemStep(db, 3, "idle", "task_notification");
        answerStep(db, 4, "IDLE", "idle");
        // Id-only GENERIC_TOOL without execution_id (field 12 omitted).
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (5, 132, 3, ?)",
        ).run(
          Buffer.concat([
            bytes(5, bytes(4, textField(1, "read"))),
            bytes(140, bytes(2, textField(1, "IMPORTANT_RESULT"))),
          ]),
        );
        stamp(1, 1_200);
        stamp(3, 900);
      } finally {
        db.close();
      }
      const windows = [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }];
      await savePromptWindows(r1.sourceRef.nativeSessionId, windows, r1.options.adapterEnvironment);
      const history = await readNativeHistory(r1.sourceRef.nativeSessionId, r1.home, {
        promptWindows: windows,
      });
      expect(history.events).toMatchObject([
        { type: "user.text", text: "first", nativeTurnIndex: 0 },
        { type: "tool.call", toolCallId: "read", name: "view_file" },
        {
          type: "tool.update",
          toolCallId: "read",
          status: "completed",
          rawOutput: "IMPORTANT_RESULT",
        },
        { type: "history.autonomous", stepIndex: 3, createdAtMs: 900 },
        { type: "agent.text", text: "IDLE" },
      ]);
      expect(
        await forkAntigravitySession({
          ...r1.options,
          input: {
            kind: "fork",
            cwd: r1.home,
            sourceRef: r1.sourceRef,
            checkpoint: { ...r1.sourceRef, checkpointId: "turn-0" },
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    }

    // 2. R2: original foreground run reply returning after an independent wake.
    const r2 = await fixture();
    {
      const db = new DatabaseSync(r2.file);
      const stamp = (idx: number, ms: number) => {
        db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
          bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
          idx,
        );
      };
      try {
        db.exec(
          "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
        );
        userStep(db, 0, "first", "p");
        systemStep(db, 1, "in-prompt", "task_notification");
        systemStep(db, 3, "idle", "task_notification");
        answerStep(db, 4, "IDLE", "idle");
        answerStep(db, 5, "FOREGROUND_RESULT", "p");
        stamp(1, 1_200);
        stamp(3, 900);
      } finally {
        db.close();
      }
      const windows = [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }];
      await savePromptWindows(r2.sourceRef.nativeSessionId, windows, r2.options.adapterEnvironment);
      const history = await readNativeHistory(r2.sourceRef.nativeSessionId, r2.home, {
        promptWindows: windows,
      });
      expect(history.events).toEqual([
        { type: "user.text", text: "first", nativeTurnIndex: 0 },
        { type: "agent.text", text: "FOREGROUND_RESULT" },
        { type: "history.autonomous", stepIndex: 3, createdAtMs: 900 },
        { type: "agent.text", text: "IDLE" },
      ]);
      expect(
        await forkAntigravitySession({
          ...r2.options,
          input: {
            kind: "fork",
            cwd: r2.home,
            sourceRef: r2.sourceRef,
            checkpoint: { ...r2.sourceRef, checkpointId: "turn-0" },
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    }

    // 3. R3: Plan handoff after interleaved wakes between Plan call, tool result, and handoff.
    const r3 = await fixture();
    {
      const db = new DatabaseSync(r3.file);
      const stamp = (idx: number, ms: number) => {
        db.prepare("UPDATE steps SET metadata = ? WHERE idx = ?").run(
          bytes(1, nanoseconds(BigInt(ms) * 1_000_000n)),
          idx,
        );
      };
      try {
        db.exec(
          "PRAGMA user_version = 1; DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, metadata BLOB)",
        );
        userStep(db, 0, "first", "p");
        systemStep(db, 1, "w", "task_notification");
        const exitCall = Buffer.concat([textField(1, "exit-call"), textField(2, "exit_plan_mode")]);
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 15, 3, ?)",
        ).run(Buffer.concat([runField("w"), bytes(20, bytes(7, exitCall))]));
        systemStep(db, 3, "idle-1", "task_notification");
        answerStep(db, 4, "IDLE_1", "idle-1");
        db.prepare(
          "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (5, 132, 3, ?)",
        ).run(
          Buffer.concat([
            bytes(5, Buffer.concat([textField(12, "w"), bytes(4, exitCall)])),
            bytes(140, Buffer.alloc(0)),
          ]),
        );
        systemStep(db, 6, "idle-2", "task_notification");
        answerStep(db, 7, "IDLE_2", "idle-2");
        systemStep(db, 8, "w-plan", "plan_mode_handoff");
        answerStep(db, 9, "USER_PLAN_RESULT", "w-plan");
        stamp(1, 1_200);
        stamp(3, 900);
        stamp(6, 950);
      } finally {
        db.close();
      }
      const windows = [{ submittedAtMs: 1_000, returnedAtMs: 2_000 }];
      await savePromptWindows(r3.sourceRef.nativeSessionId, windows, r3.options.adapterEnvironment);
      const history = await readNativeHistory(r3.sourceRef.nativeSessionId, r3.home, {
        promptWindows: windows,
      });
      expect(history.events).toMatchObject([
        { type: "user.text", text: "first", nativeTurnIndex: 0 },
        { type: "tool.call", toolCallId: "exit-call", name: "exit_plan_mode" },
        { type: "tool.update", toolCallId: "exit-call", status: "completed" },
        { type: "agent.text", text: "USER_PLAN_RESULT" },
        { type: "history.autonomous", stepIndex: 3, createdAtMs: 900 },
        { type: "agent.text", text: "IDLE_1" },
        { type: "history.autonomous", stepIndex: 6, createdAtMs: 950 },
        { type: "agent.text", text: "IDLE_2" },
      ]);
      // Forking to wake-3 (cutoff=6) would cut off USER_PLAN_RESULT (idx=9) and must be rejected.
      expect(
        await forkAntigravitySession({
          ...r3.options,
          input: {
            kind: "fork",
            cwd: r3.home,
            sourceRef: r3.sourceRef,
            checkpoint: { ...r3.sourceRef, checkpointId: "wake-3" },
          },
        }),
      ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
      // Forking to wake-6 retains the entire prefix safely.
      const safe = await forkAntigravitySession({
        ...r3.options,
        input: {
          kind: "fork",
          cwd: r3.home,
          sourceRef: r3.sourceRef,
          checkpoint: { ...r3.sourceRef, checkpointId: "wake-6" },
        },
      });
      expect(safe.ok).toBe(true);
    }
  });

  it("rejects another Harness, foreign checkpoint and active source", async () => {
    const f = await fixture();
    const input = {
      kind: "fork" as const,
      sourceRef: f.sourceRef,
      checkpoint: { ...f.sourceRef, checkpointId: "turn-1" },
      cwd: f.home,
    };
    expect(
      await forkAntigravitySession({
        ...f.options,
        input: { ...input, sourceRef: { ...f.sourceRef, harnessId: harnessIdSchema.parse("pi") } },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(
      await forkAntigravitySession({
        ...f.options,
        input: { ...input, checkpoint: { ...input.checkpoint, nativeSessionId: "other" } },
      }),
    ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(
      await forkAntigravitySession({ ...f.options, input, sourceSession: { isActive: true } }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy", retryable: true } });
    expect(
      await forkAntigravitySession({
        ...f.options,
        input,
        sourceSession: { isActive: true, activeForkTurnIndex: () => 2 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "sessionBusy", retryable: true, message: expect.stringContaining("WAL") },
    });
    expect(f.openSession).not.toHaveBeenCalled();
  });
});
