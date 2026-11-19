import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)",
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
  it.each([0, 1, 2])(
    "retains exactly the prefix through turn-%i and supports another cwd",
    async (index) => {
      const f = await fixture();
      const before = await readFile(f.file);
      const result = await forkAntigravitySession({
        ...f.options,
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
      expect(await readNativeTurnCount(nativeConversationDbPath(id, f.home))).toBe(index + 1);
      expect(await readFile(f.file)).toEqual(before);
      expect(await readFile(path.join(nativeBrainDirPath(id, f.home), "artifact.md"), "utf8")).toBe(
        "artifact",
      );
      expect(await readdir(nativeBrainDirPath(id, f.home))).toEqual(["artifact.md"]);
    },
  );
  it.each([
    "turn-3",
    "turn--1",
    "turn-01",
    "turn-0junk",
    "turn-1.5",
    "turn-9007199254740993",
    "host-turn",
    "turn:1",
  ])("rejects checkpoint %s before cloning", async (checkpointId) => {
    const f = await fixture();
    expect(
      await forkAntigravitySession({
        ...f.options,
        input: {
          kind: "fork",
          sourceRef: f.sourceRef,
          checkpoint: { ...f.sourceRef, checkpointId },
          cwd: f.home,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "checkpointNotFound" } });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(f.file))).toEqual([path.basename(f.file)]);
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
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    expect(f.openSession).not.toHaveBeenCalled();
  });
});
