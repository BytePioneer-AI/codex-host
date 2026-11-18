import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeSessionRefSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import {
  answerStep,
  createNativeHistoryDatabase,
  textField,
  userStep,
} from "./support/native-history-fixture.js";
import { bytes } from "./support/native-timing-fixture.js";

const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "antigravity",
  nativeSessionId: "history",
  formatVersion: 1,
});
const call = (id: string, name: string, args: object) =>
  bytes(
    7,
    Buffer.concat([textField(1, id), textField(2, name), textField(3, JSON.stringify(args))]),
  );
const callMetadata = (id: string) => bytes(5, bytes(4, textField(1, id)));
const result = (id: string, output: string) =>
  Buffer.concat([callMetadata(id), bytes(140, bytes(2, textField(1, output)))]);

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

  it("keeps known Turn keys, legacy grouping and item order while decoding committed step content", async () => {
    const knownTurnRefs = ["turn-0", "turn-2"].map((nativeTurnKey) =>
      nativeTurnRefSchema.parse({ ...nativeRef, nativeTurnKey }),
    );
    const opened = await adapter.open({ kind: "resume", nativeRef, cwd: home, knownTurnRefs });
    assert(opened.ok);
    const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
    try {
      const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
      answerStep(db, 14, "Second reply");
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
        Buffer.concat([
          callMetadata("missing"),
          bytes(140, Buffer.alloc(0)),
          bytes(31, textField(2, "Not found")),
        ]),
      );
      insert.run(6, 132, 3, result("read", "x".repeat(128)));
      insert.run(7, 132, 2, result("pending", "Not settled yet"));
      answerStep(db, 8, "First paragraph.");
      answerStep(db, 10, "Second paragraph.");
      insert.run(11, 17, 3, bytes(24, bytes(3, textField(2, "Retry suggested"))));
      userStep(db, 13, "Next question");

      const snapshot = await opened.value.readSnapshot();
      assert(snapshot.ok);
      expect(snapshot.value.turns.map((turn) => turn.nativeTurnRef)).toEqual(knownTurnRefs);
      expect(snapshot.value.turns.map((turn) => turn.checkpoint?.checkpointId)).toEqual([
        "turn-0",
        "turn-1",
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

  it.each(["missing", "unknown schema version", "unknown step payload", "invalid protobuf"])(
    "reports history unavailable for %s, without ACP or transcript fallback",
    async (failure) => {
      if (failure !== "missing") {
        const db = await createNativeHistoryDatabase(home, nativeRef.nativeSessionId);
        try {
          if (failure === "unknown schema version") db.exec("PRAGMA user_version = 2");
          else
            db.prepare("INSERT INTO steps VALUES (0, 15, 3, ?)").run(
              failure === "unknown step payload"
                ? textField(99, "Unrecognized")
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
    },
  );
});
