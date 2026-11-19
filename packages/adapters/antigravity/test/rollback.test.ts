import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessSession, ResumeSessionInput } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minimalTrajectoryMetadataBlob, nativeConversationDbPath } from "../src/fork.js";
import { readNativeTurnCount } from "../src/native-turn-boundaries.js";
import { rollbackAntigravityLastTurn } from "../src/rollback.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture(turns: number) {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-rollback-"));
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
  for (let turn = 0; turn < turns; turn++)
    db.prepare("INSERT INTO steps VALUES (?,14), (?,15), (?,16)").run(
      turn * 3,
      turn * 3 + 1,
      turn * 3 + 2,
    );
  db.close();
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
describe("native SQLite Rollback", () => {
  it.each([1, 2, 5])("removes exactly one complete user Turn from %i Turns", async (turns) => {
    const f = await fixture(turns);
    const before = await readFile(f.file);
    const settings = {
      model: harnessModelRefSchema.parse({ id: "gemini" }),
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      permissionModeId: harnessPermissionModeIdSchema.parse("dangerously-skip-permissions"),
    };
    const result = await rollbackAntigravityLastTurn({
      ...f.options,
      input: {
        kind: "rollbackLastTurn",
        sourceRef: f.sourceRef,
        cwd: f.home,
        environment: { CODEXHOST_THREAD_ID: "derived" },
        ...settings,
      },
    });
    expect(result.ok).toBe(true);
    const opened = f.openSession.mock.calls[0]?.[0];
    assert(opened);
    const id = opened.nativeRef.nativeSessionId;
    expect(opened).toMatchObject({
      kind: "resume",
      ...settings,
      environment: { CODEXHOST_THREAD_ID: "derived" },
      nativeRef: { locator: { executionPolicy: "unattended-full-access" } },
    });
    expect(await readNativeTurnCount(nativeConversationDbPath(id, f.home))).toBe(turns - 1);
    const db = new DatabaseSync(nativeConversationDbPath(id, f.home), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS n FROM steps").get()?.n).toBe((turns - 1) * 3);
    db.close();
    expect(await readFile(f.file)).toEqual(before);
  });
  it("rejects empty, missing and busy history without opening or modifying a Session", async () => {
    const f = await fixture(0);
    const input = { kind: "rollbackLastTurn" as const, sourceRef: f.sourceRef, cwd: f.home };
    expect(await rollbackAntigravityLastTurn({ ...f.options, input })).toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    expect(
      await rollbackAntigravityLastTurn({ ...f.options, input, sourceSession: { isActive: true } }),
    ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    await rm(f.file);
    expect(await rollbackAntigravityLastTurn({ ...f.options, input })).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    expect(f.openSession).not.toHaveBeenCalled();
    expect(await readdir(path.dirname(f.file))).toEqual([]);
  });
});
