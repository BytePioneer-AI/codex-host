import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import {
  cloneNativeConversationDb,
  ensureNativeConversationDb,
  minimalTrajectoryMetadataBlob,
  nativeBrainDirPath,
  nativeConversationDbPath,
  nativeConversationSummariesDbPath,
  seedNativeConversationDb,
} from "../src/fork.js";
import { AntigravityHistory } from "../src/history.js";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-clone-"));
  const nativeRef = nativeSessionRefSchema.parse({
    harnessId: "antigravity",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CODEXHOST_DATA_DIR: home,
    CODEXHOST_THREAD_ID: "source",
  };
  const command = path.join(home, process.platform === "win32" ? "agy.cmd" : "agy");
  await writeFile(
    command,
    process.platform === "win32"
      ? "@echo gemini-3.7-flash\tGemini 3.7 Flash\r\n"
      : "#!/bin/sh\nprintf 'gemini-3.7-flash\\tGemini 3.7 Flash\\n'\n",
  );
  await chmod(command, 0o755);
  const adapter = new AntigravityAdapter({ command, environment });
  const history = await AntigravityHistory.open({
    environment,
    nativeSessionId: nativeRef.nativeSessionId,
  });
  for (let turn = 1; turn <= 3; turn++) {
    history.append({
      nativeTurnRef: { ...nativeRef, nativeTurnKey: `turn:${turn}` },
      checkpoint: { ...nativeRef, checkpointId: `turn:${turn}` },
      turnInput: [{ type: "text", text: `question ${turn}` }],
      items: [],
      outcome: { status: "succeeded" },
    });
  }
  await history.flush();
  expect(await seedNativeConversationDb(nativeRef.nativeSessionId, home)).toBe(true);
  const sourcePath = nativeConversationDbPath(nativeRef.nativeSessionId, home);
  const brainPath = nativeBrainDirPath(nativeRef.nativeSessionId, home);
  await mkdir(brainPath, { recursive: true });
  await writeFile(path.join(brainPath, "artifact.txt"), "source artifact");
  const summaries = new DatabaseSync(nativeConversationSummariesDbPath(home));
  try {
    summaries.exec(
      "INSERT INTO conversation_summaries (conversation_id, last_modified_time, workspace_uris, last_user_input_time) VALUES ('other', '2026-01-01', '[]', '2026-01-01')",
    );
  } finally {
    summaries.close();
  }
  const db = new DatabaseSync(sourcePath);
  try {
    for (let turn = 0; turn < 3; turn++) {
      db.prepare("INSERT INTO steps (idx, step_type) VALUES (?, 14), (?, 15)").run(
        turn * 2,
        turn * 2 + 1,
      );
    }
  } finally {
    db.close();
  }
  return {
    home,
    nativeRef,
    sourcePath,
    adapter,
    async cleanup() {
      await adapter.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function metadata(dbPath: string): Buffer {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get();
    if (!(row?.data instanceof Uint8Array)) throw new Error("Missing metadata");
    return Buffer.from(row.data);
  } finally {
    db.close();
  }
}

function setMetadata(dbPath: string, blob: Uint8Array): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'").run(blob);
  } finally {
    db.close();
  }
}

describe("Antigravity native clone fidelity", () => {
  it.each(["fork", "rollbackLastTurn"] as const)(
    "%s recovers a genuinely missing source database",
    async (kind) => {
      const f = await fixture();
      try {
        await rm(f.sourcePath);
        const sourceSidecar = path.join(f.home, "antigravity-history", "source.json");
        const sourceBefore = await readFile(sourceSidecar);
        const result = await f.adapter.open({
          cwd: f.home,
          sourceRef: f.nativeRef,
          ...(kind === "fork"
            ? { kind, checkpoint: { ...f.nativeRef, checkpointId: "turn:2" } }
            : { kind }),
          environment: { CODEXHOST_THREAD_ID: "derived" },
        });
        if (!result.ok) throw new Error(result.error.message);
        const derivedId = result.value.initialState.nativeRef?.nativeSessionId;
        if (!derivedId) throw new Error("Missing derived identity");
        const db = new DatabaseSync(nativeConversationDbPath(derivedId, f.home));
        try {
          expect(db.prepare("SELECT count(*) AS n FROM steps").get()?.n).toBe(0);
          expect(db.prepare("SELECT cascade_id FROM trajectory_meta").get()?.cascade_id).toBe(
            derivedId,
          );
        } finally {
          db.close();
        }
        const snapshot = await result.value.readSnapshot();
        expect(snapshot.ok && snapshot.value.turns).toHaveLength(2);
        expect(await readFile(sourceSidecar)).toEqual(sourceBefore);
        expect(await readFile(f.sourcePath).catch(() => null)).toBeNull();
        await result.value.close();
      } finally {
        await f.cleanup();
      }
    },
  );

  it("does not remove or overwrite an existing clone target (including the source itself)", async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.sourcePath);
      await expect(
        cloneNativeConversationDb(
          f.nativeRef.nativeSessionId,
          f.nativeRef.nativeSessionId,
          1,
          f.home,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(f.sourcePath)).toEqual(before);
      await rm(f.sourcePath);
      const derivedId = randomUUID();
      const target = nativeConversationDbPath(derivedId, f.home);
      await writeFile(target, "existing target");
      await expect(
        cloneNativeConversationDb(f.nativeRef.nativeSessionId, derivedId, 1, f.home),
      ).rejects.toThrow("already exists");
      expect(await readFile(target, "utf8")).toBe("existing target");
    } finally {
      await f.cleanup();
    }
  });

  it("preserves full uint64 and unknown field bytes while rewriting only cascade identity", async () => {
    const f = await fixture();
    try {
      const unknown = Buffer.from([
        0x98,
        0x01,
        ...Array<number>(9).fill(0xff),
        0x01, // field 19, uint64 max
        0xa0,
        0x01,
        0x80,
        0x00, // field 20, noncanonical zero
        0xa9,
        0x01,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8, // field 21, fixed64
        0xb2,
        0x01,
        3,
        0xff,
        0x00,
        0xfe, // field 22, bytes
        0xbd,
        0x01,
        9,
        10,
        11,
        12, // field 23, fixed32
      ]);
      const before = Buffer.concat([
        minimalTrajectoryMetadataBlob(f.nativeRef.nativeSessionId, "custom-project"),
        unknown,
      ]);
      setMetadata(f.sourcePath, before);
      const sourceBefore = await readFile(f.sourcePath);
      const derivedId = randomUUID();
      expect(
        await cloneNativeConversationDb(f.nativeRef.nativeSessionId, derivedId, 2, f.home),
      ).toBe(true);
      expect(metadata(nativeConversationDbPath(derivedId, f.home))).toEqual(
        Buffer.concat([minimalTrajectoryMetadataBlob(derivedId, "custom-project"), unknown]),
      );
      expect(await readFile(f.sourcePath)).toEqual(sourceBefore);
      await ensureNativeConversationDb(f.nativeRef.nativeSessionId, f.home, true);
      expect(metadata(f.sourcePath)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it.each(
    (["fork", "rollbackLastTurn"] as const).flatMap((kind) =>
      (["corrupt-db", "truncated-metadata", "overflow-varint", "invalid-tag"] as const).map(
        (failure) => ({ kind, failure }),
      ),
    ),
  )("$kind rejects $failure without publishing or altering sidecars", async ({ kind, failure }) => {
    const f = await fixture();
    try {
      if (failure === "corrupt-db") await writeFile(f.sourcePath, "not a SQLite database");
      else
        setMetadata(
          f.sourcePath,
          failure === "truncated-metadata"
            ? Buffer.from([0x32, 0x7f])
            : failure === "overflow-varint"
              ? Buffer.from([0x98, 0x01, ...Array<number>(9).fill(0xff), 0x02])
              : Buffer.from([0x00, 0x01]),
        );
      const sourceBefore = await readFile(f.sourcePath);
      const sourceSidecar = path.join(f.home, "antigravity-history", "source.json");
      const sidecarBefore = await readFile(sourceSidecar);
      // A failed derivation must not overwrite an existing destination Thread's sidecar.
      const derivedSidecar = path.join(f.home, "antigravity-history", "derived.json");
      await writeFile(derivedSidecar, "unrelated sidecar");
      const summariesPath = nativeConversationSummariesDbPath(f.home);
      const summariesBefore = await readFile(summariesPath);
      const result = await f.adapter.open({
        cwd: f.home,
        sourceRef: f.nativeRef,
        ...(kind === "fork"
          ? { kind, checkpoint: { ...f.nativeRef, checkpointId: "turn:2" } }
          : { kind }),
        environment: { CODEXHOST_THREAD_ID: "derived" },
      });
      if (result.ok) await result.value.close();
      expect(result, failure).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
      expect(await readFile(f.sourcePath)).toEqual(sourceBefore);
      expect(await readFile(sourceSidecar)).toEqual(sidecarBefore);
      expect(await readFile(derivedSidecar, "utf8")).toBe("unrelated sidecar");
      expect(await readdir(path.dirname(f.sourcePath))).toEqual([path.basename(f.sourcePath)]);
      expect(await readFile(summariesPath)).toEqual(summariesBefore);
      expect(
        await readdir(path.dirname(nativeBrainDirPath(f.nativeRef.nativeSessionId, f.home))),
      ).toEqual([f.nativeRef.nativeSessionId]);
    } finally {
      await f.cleanup();
    }
  });

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["fork", "rollbackLastTurn"] as const)(
    "%s propagates source read permission errors and leaves no derived artifacts",
    async (kind) => {
      const f = await fixture();
      try {
        const sourceBefore = await readFile(f.sourcePath);
        const summariesBefore = await readFile(nativeConversationSummariesDbPath(f.home));
        await chmod(f.sourcePath, 0o000);
        let result;
        try {
          result = await f.adapter.open({
            cwd: f.home,
            sourceRef: f.nativeRef,
            ...(kind === "fork"
              ? { kind, checkpoint: { ...f.nativeRef, checkpointId: "turn:2" } }
              : { kind }),
            environment: { CODEXHOST_THREAD_ID: "derived" },
          });
        } finally {
          await chmod(f.sourcePath, 0o600);
        }
        if (result.ok) await result.value.close();
        expect(result).toMatchObject({ ok: false, error: { code: "nativeFailure" } });
        expect(await readdir(path.join(f.home, "antigravity-history"))).toEqual(["source.json"]);
        expect(await readdir(path.dirname(f.sourcePath))).toEqual([path.basename(f.sourcePath)]);
        expect(await readFile(f.sourcePath)).toEqual(sourceBefore);
        expect(await readFile(nativeConversationSummariesDbPath(f.home))).toEqual(summariesBefore);
        expect(
          await readdir(path.dirname(nativeBrainDirPath(f.nativeRef.nativeSessionId, f.home))),
        ).toEqual([f.nativeRef.nativeSessionId]);
      } finally {
        await f.cleanup();
      }
    },
  );
});
