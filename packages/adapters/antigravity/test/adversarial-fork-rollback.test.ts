import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessResult, HarnessSession } from "@codexhost/harness-adapter";
import { harnessIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forkAntigravitySession,
  minimalTrajectoryMetadataBlob,
  nativeBrainDirPath,
  nativeConversationDbPath,
  nativeConversationSummariesDbPath,
} from "../src/fork.js";
import { rollbackAntigravityLastTurn } from "../src/rollback.js";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-adversarial-"));
  homes.push(home);
  const sourceRef = nativeSessionRefSchema.parse({
    harnessId: "antigravity",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  const file = nativeConversationDbPath(sourceRef.nativeSessionId, home);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); INSERT INTO steps VALUES (0,14),(1,15),(2,14),(3,15)",
  );
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(
    randomUUID(),
    sourceRef.nativeSessionId,
  );
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
    minimalTrajectoryMetadataBlob(sourceRef.nativeSessionId),
  );
  db.close();
  const summaries = new DatabaseSync(nativeConversationSummariesDbPath(home));
  summaries.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, status TEXT, step_count INTEGER, last_modified_time TEXT, raw_summary BLOB)",
  );
  summaries
    .prepare(
      "INSERT INTO conversation_summaries VALUES (?, 'CASCADE_RUN_STATUS_IDLE', 4, 'original', ?)",
    )
    .run(sourceRef.nativeSessionId, Buffer.from("source-summary"));
  summaries.close();
  const brain = nativeBrainDirPath(sourceRef.nativeSessionId, home);
  await mkdir(brain, { recursive: true });
  await writeFile(path.join(brain, "source.md"), "source artifact");
  const openSession = vi.fn(async (): Promise<HarnessResult<HarnessSession>> => ({
    ok: false,
    error: { code: "authenticationRequired", message: "Login required", retryable: false },
  }));
  return { home, sourceRef, file, brain, openSession };
}
describe.each(["fork", "rollbackLastTurn"] as const)("%s adversarial derivation", (kind) => {
  const derive = (f: Awaited<ReturnType<typeof fixture>>, sourceRef = f.sourceRef) => {
    const common = {
      harnessId: harnessIdSchema.parse("antigravity"),
      adapterEnvironment: { HOME: f.home, USERPROFILE: f.home },
      openSession: f.openSession,
    };
    return kind === "fork"
      ? forkAntigravitySession({
          ...common,
          input: {
            kind,
            sourceRef,
            checkpoint: { ...sourceRef, checkpointId: "turn-0" },
            cwd: f.home,
          },
        })
      : rollbackAntigravityLastTurn({ ...common, input: { kind, sourceRef, cwd: f.home } });
  };
  it("cleans only derived DB/brain after resume fails", async () => {
    const f = await fixture();
    const before = await readFile(f.file);
    expect(await derive(f)).toMatchObject({ ok: false, error: { code: "authenticationRequired" } });
    expect(await readFile(f.file)).toEqual(before);
    expect(await readFile(path.join(f.brain, "source.md"), "utf8")).toBe("source artifact");
    expect(await readdir(path.dirname(f.file))).toEqual([path.basename(f.file)]);
    expect(await readdir(path.dirname(f.brain))).toEqual([f.sourceRef.nativeSessionId]);
    const summaries = new DatabaseSync(nativeConversationSummariesDbPath(f.home), {
      readOnly: true,
    });
    expect(
      summaries
        .prepare(
          "SELECT conversation_id, last_modified_time, raw_summary FROM conversation_summaries",
        )
        .all(),
    ).toEqual([
      expect.objectContaining({
        conversation_id: f.sourceRef.nativeSessionId,
        last_modified_time: "original",
        raw_summary: new Uint8Array(Buffer.from("source-summary")),
      }),
    ]);
    summaries.close();
  });
  it.each(["corrupt-db", "corrupt-metadata", "missing"])(
    "rejects %s without restoring imaginary history",
    async (failure) => {
      const f = await fixture();
      if (failure === "missing") await rm(f.file);
      else if (failure === "corrupt-db") await writeFile(f.file, "not sqlite");
      else {
        const db = new DatabaseSync(f.file);
        db.prepare("UPDATE trajectory_metadata_blob SET data = ?").run(Buffer.from([0x32, 0x7f]));
        db.close();
      }
      const before = await readFile(f.file).catch(() => null);
      expect(await derive(f)).toMatchObject({
        ok: false,
        error: { code: failure === "missing" ? "sessionNotFound" : "nativeFailure" },
      });
      expect(f.openSession).not.toHaveBeenCalled();
      expect(await readFile(f.file).catch(() => null)).toEqual(before);
      expect(await readdir(path.dirname(f.file))).toEqual(
        failure === "missing" ? [] : [path.basename(f.file)],
      );
    },
  );
  it("rejects traversal identities before touching storage", async () => {
    const f = await fixture();
    expect(await derive(f, { ...f.sourceRef, nativeSessionId: "../../escape" })).toMatchObject({
      ok: false,
      error: { code: "invalidRequest" },
    });
    expect(f.openSession).not.toHaveBeenCalled();
  });
});
