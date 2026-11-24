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
import { rollbackAntigravityLastTurn } from "../src/rollback.js";
import {
  answerStep,
  planModeSwitch,
  systemStep,
  textField,
  userStep,
} from "../../../../tests/fixtures/antigravity/native-history-fixture.js";
import {
  bytes,
  integer,
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
