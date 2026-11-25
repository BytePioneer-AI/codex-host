import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloneNativeConversationDb,
  forkAntigravitySession,
  minimalTrajectoryMetadataBlob,
  nativeConversationDbPath,
  nativeConversationSummariesDbPath,
} from "../src/fork.js";
import {
  bytes,
  nanoseconds,
} from "../../../../tests/fixtures/antigravity/native-timing-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-clone-"));
  homes.push(home);
  const sourceId = randomUUID();
  const derivedId = randomUUID();
  const file = nativeConversationDbPath(sourceId, home);
  await mkdir(path.dirname(file), { recursive: true });
  const source = new DatabaseSync(file);
  source.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)",
  );
  source.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(randomUUID(), sourceId);
  source
    .prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)")
    .run(minimalTrajectoryMetadataBlob(sourceId));
  source.exec(
    "INSERT INTO steps (idx, step_type) VALUES (0,14),(1,15),(2,16),(3,14),(4,15),(5,14),(6,15)",
  );
  source
    .prepare("UPDATE steps SET metadata = ? WHERE idx = 0")
    .run(bytes(1, nanoseconds(1_700_000_000_123_000_000n)));
  return { home, sourceId, derivedId, file, source };
}
describe("SQLite clone fidelity", () => {
  it("trims the same WAL snapshot used to find the boundary despite a concurrent commit", async () => {
    const f = await fixture();
    const reserve = vi.mocked(fs.open);
    const open = reserve.getMockImplementation();
    if (!open) throw new Error("Missing mock implementation for fs.open");
    // The transaction has read the boundary by the time it reserves the destination.
    reserve.mockImplementationOnce((...args) => {
      if (args[0] === nativeConversationDbPath(f.derivedId, f.home)) {
        f.source.exec(
          "BEGIN IMMEDIATE; UPDATE steps SET step_type = 17 WHERE idx = 2; UPDATE steps SET idx = 7 WHERE idx = 5; INSERT INTO steps (idx, step_type) VALUES (5, 15); COMMIT",
        );
      }
      return open(...args);
    });
    try {
      expect(
        await cloneNativeConversationDb(f.sourceId, f.derivedId, 2, f.home, { activeTurnIndex: 2 }),
      ).toBe(true);
      const target = new DatabaseSync(nativeConversationDbPath(f.derivedId, f.home), {
        readOnly: true,
      });
      try {
        expect(
          target
            .prepare("SELECT idx FROM steps ORDER BY idx")
            .all()
            .map((row) => row.idx),
        ).toEqual([0, 1, 2, 3, 4]);
        expect(target.prepare("SELECT step_type FROM steps WHERE idx = 2").get()?.step_type).toBe(
          16,
        );
        expect(target.prepare("SELECT cascade_id FROM trajectory_meta").get()?.cascade_id).toBe(
          f.derivedId,
        );
        expect(
          f.source
            .prepare("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1")
            .get()?.idx,
        ).toBe(7);
      } finally {
        target.close();
      }
    } finally {
      reserve.mockReset();
      f.source.close();
    }
  });
  it("preserves unknown protobuf bytes while rewriting only cascade identity", async () => {
    const f = await fixture();
    const unknown = Buffer.from([
      0x98,
      0x01,
      ...Array<number>(9).fill(0xff),
      0x01,
      0xb2,
      0x01,
      3,
      0xff,
      0,
      0xfe,
    ]);
    const before = Buffer.concat([
      minimalTrajectoryMetadataBlob(f.sourceId, "custom-project"),
      unknown,
    ]);
    f.source.prepare("UPDATE trajectory_metadata_blob SET data = ?").run(before);
    f.source.close();
    const sourceBytes = await readFile(f.file);
    await cloneNativeConversationDb(f.sourceId, f.derivedId, 1, f.home);
    const db = new DatabaseSync(nativeConversationDbPath(f.derivedId, f.home), { readOnly: true });
    expect(
      Buffer.from(
        db.prepare("SELECT data FROM trajectory_metadata_blob").get()?.data as Uint8Array,
      ),
    ).toEqual(
      Buffer.concat([minimalTrajectoryMetadataBlob(f.derivedId, "custom-project"), unknown]),
    );
    db.close();
    expect(await readFile(f.file)).toEqual(sourceBytes);
  });
  it("never overwrites a preexisting target or the source itself", async () => {
    const f = await fixture();
    f.source.close();
    const before = await readFile(f.file);
    await expect(
      cloneNativeConversationDb(f.sourceId, f.sourceId, 1, f.home),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const target = nativeConversationDbPath(f.derivedId, f.home);
    await writeFile(target, "owned by someone else");
    await expect(
      cloneNativeConversationDb(f.sourceId, f.derivedId, 1, f.home),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("owned by someone else");
    expect(await readFile(f.file)).toEqual(before);
  });
  it.each([-1, 4, 1.5, NaN])(
    "rejects retained count %s before reserving the target",
    async (retained) => {
      const f = await fixture();
      f.source.close();
      await expect(
        cloneNativeConversationDb(f.sourceId, f.derivedId, retained, f.home),
      ).rejects.toThrow("Invalid retained");
      expect((await readdir(path.dirname(f.file))).filter((name) => name.endsWith(".db"))).toEqual([
        path.basename(f.file),
      ]);
    },
  );
  it.each(["writable", "locked", "reporting an active Subagent"])(
    "registers prefix statistics or refuses cleanly when the summaries DB is %s",
    async (access) => {
      const f = await fixture();
      f.source.close();
      const summaries = new DatabaseSync(nativeConversationSummariesDbPath(f.home));
      try {
        summaries.exec(
          "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, status TEXT, step_count INTEGER, last_modified_time TEXT, raw_summary BLOB, last_user_input_step_index INTEGER, last_user_input_time TEXT NOT NULL, not_fully_idle INTEGER, killed INTEGER, parent_conversation_id TEXT)",
        );
        summaries
          .prepare(
            "INSERT INTO conversation_summaries VALUES (?, 'CASCADE_RUN_STATUS_RUNNING', 2, 'original-time', ?, 5, '2023-11-15T00:00:00Z', 1, 1, NULL)",
          )
          .run(f.sourceId, Buffer.from("original-summary"));
        const getSummary = summaries.prepare(
          "SELECT * FROM conversation_summaries WHERE conversation_id = ?",
        );
        const before = getSummary.get(f.sourceId);
        if (access !== "writable") {
          const childId = randomUUID();
          if (access === "locked") summaries.exec("BEGIN IMMEDIATE");
          else
            summaries
              .prepare(
                `INSERT INTO conversation_summaries (conversation_id, status, last_user_input_time, parent_conversation_id)
            VALUES (?, 'CASCADE_RUN_STATUS_RUNNING', '', ?)`,
              )
              .run(childId, f.sourceId);
          const harnessId = harnessIdSchema.parse("antigravity");
          const sourceRef = { harnessId, nativeSessionId: f.sourceId, formatVersion: 1 as const };
          const openSession = vi.fn();
          expect(
            await forkAntigravitySession({
              harnessId,
              adapterEnvironment: { HOME: f.home, USERPROFILE: f.home },
              sourceSession: { isActive: true, activeForkTurnIndex: () => 2 },
              input: {
                kind: "fork",
                sourceRef,
                checkpoint: { ...sourceRef, checkpointId: "turn-0" },
                cwd: f.home,
              },
              openSession,
            }),
          ).toMatchObject({
            ok: false,
            error: {
              code: "sessionBusy",
              retryable: true,
              message: expect.stringContaining(access === "locked" ? "locked" : "Subagent"),
            },
          });
          expect(openSession).not.toHaveBeenCalled();
          expect(
            (await readdir(path.dirname(f.file))).filter((name) => name.endsWith(".db")),
          ).toEqual([path.basename(f.file)]);
          expect(
            summaries
              .prepare("SELECT conversation_id FROM conversation_summaries")
              .all()
              .map((row) => row.conversation_id)
              .sort(),
          ).toEqual((access === "locked" ? [f.sourceId] : [f.sourceId, childId]).sort());
        } else {
          await cloneNativeConversationDb(f.sourceId, f.derivedId, 1, f.home);
          expect(getSummary.get(f.derivedId)).toMatchObject({
            status: "CASCADE_RUN_STATUS_IDLE",
            step_count: 3,
            last_user_input_step_index: 0,
            last_user_input_time: "2023-11-14T22:13:20.123Z",
            not_fully_idle: 0,
            killed: 0,
          });
        }
        expect(getSummary.get(f.sourceId)).toEqual(before);
      } finally {
        summaries.close();
      }
    },
  );
});
