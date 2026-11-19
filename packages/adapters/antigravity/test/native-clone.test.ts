import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  cloneNativeConversationDb,
  minimalTrajectoryMetadataBlob,
  nativeConversationDbPath,
  nativeConversationSummariesDbPath,
} from "../src/fork.js";
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
    "PRAGMA journal_mode=WAL; CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER); CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER, data BLOB)",
  );
  source.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(randomUUID(), sourceId);
  source
    .prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)")
    .run(minimalTrajectoryMetadataBlob(sourceId));
  source.exec(
    "INSERT INTO steps VALUES (0,14),(1,15),(2,16),(3,14),(4,15),(5,14),(6,15); INSERT INTO executor_metadata VALUES (0,NULL),(3,NULL),(5,NULL)",
  );
  return { home, sourceId, derivedId, file, source };
}
describe("SQLite clone fidelity", () => {
  it("includes committed WAL pages and truncates by native user-input boundary", async () => {
    const f = await fixture();
    try {
      expect(await cloneNativeConversationDb(f.sourceId, f.derivedId, 2, f.home)).toBe(true);
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
        expect(
          target
            .prepare("SELECT idx FROM executor_metadata ORDER BY idx")
            .all()
            .map((row) => row.idx),
        ).toEqual([0, 3]);
        expect(target.prepare("SELECT cascade_id FROM trajectory_meta").get()?.cascade_id).toBe(
          f.derivedId,
        );
        expect(f.source.prepare("SELECT count(*) AS n FROM steps").get()?.n).toBe(7);
      } finally {
        target.close();
      }
    } finally {
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
  it("registers a derived summary without mutating the source summary", async () => {
    const f = await fixture();
    f.source.close();
    const summaries = new DatabaseSync(nativeConversationSummariesDbPath(f.home));
    summaries.exec(
      "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, status TEXT, step_count INTEGER, last_modified_time TEXT, raw_summary BLOB, last_user_input_step_index INTEGER DEFAULT 5)",
    );
    summaries
      .prepare(
        "INSERT INTO conversation_summaries (conversation_id, status, step_count, last_modified_time, raw_summary) VALUES (?, 'CASCADE_RUN_STATUS_IDLE', 7, 'original-time', ?)",
      )
      .run(f.sourceId, Buffer.from("original-summary"));
    const before = summaries
      .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
      .get(f.sourceId);
    await cloneNativeConversationDb(f.sourceId, f.derivedId, 1, f.home);
    expect(
      summaries
        .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
        .get(f.sourceId),
    ).toEqual(before);
    expect(
      summaries
        .prepare("SELECT step_count FROM conversation_summaries WHERE conversation_id = ?")
        .get(f.derivedId)?.step_count,
    ).toBe(3);
    expect(
      summaries
        .prepare(
          "SELECT last_user_input_step_index FROM conversation_summaries WHERE conversation_id = ?",
        )
        .get(f.derivedId)?.last_user_input_step_index,
    ).toBe(0);
    summaries.close();
  });
});
