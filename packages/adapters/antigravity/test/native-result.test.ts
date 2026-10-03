import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";

import { AntigravityAdapter } from "../src/antigravity-adapter.js";
import { nativeConversationDbPath } from "../src/fork.js";
import { captureNativeTurnBoundary, isHistoricalNativeError } from "../src/native-result.js";

const ID = "00000000-0000-4000-8000-000000000001";
const ERROR = "Individual quota reached. Resets in 4h52m37s.";
const result = { conversation_id: ID, status: "ERROR", error: ERROR, num_turns: 2 };

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-native-result-"));
  const file = nativeConversationDbPath(ID, home);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE trajectory_meta(cascade_id TEXT);
    CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER,
      error_details BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare("INSERT INTO trajectory_meta VALUES (?)").run(ID);
  const step = (index: number, type: number, text = "", status = 3) =>
    db
      .prepare("INSERT INTO steps VALUES (?, ?, ?, NULL, ?)")
      .run(index, type, status, Buffer.from(text));
  step(0, 14, "Previous input");
  step(1, 17, ERROR);
  db.prepare("INSERT INTO gen_metadata VALUES (0, ?)").run(Buffer.from(ERROR));
  db.prepare("INSERT INTO executor_metadata VALUES (0, ?)").run(Buffer.from(ERROR));
  const boundary = await captureNativeTurnBoundary(ID, home);
  const fresh = () => {
    step(2, 14, "Current input");
    step(3, 15, "Fresh response");
  };
  return {
    home,
    db,
    step,
    boundary,
    fresh,
    dispose: async () => {
      db.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("Antigravity native result ownership", () => {
  it("recognizes an old error only after the new native Turn completed with fresh output", async () => {
    const f = await fixture();
    try {
      expect(f.boundary).toEqual({
        stepIndex: 1,
        generatorIndex: 0,
        executorIndex: 0,
        userCount: 1,
      });
      f.fresh();
      expect(await isHistoricalNativeError(result, f.boundary, "Fresh response", f.home)).toBe(
        true,
      );
      expect(f.db.prepare("SELECT step_type FROM steps WHERE idx=1").get()?.step_type).toBe(17);
      expect(
        await isHistoricalNativeError(
          { ...result, response: "Old response" },
          f.boundary,
          "Fresh response",
          f.home,
        ),
      ).toBe(true);
    } finally {
      await f.dispose();
    }
  });

  it.each([
    "new error step",
    "new generator error",
    "new executor error",
    "different generator error",
    "different executor error",
    "invalid metadata",
    "step error details",
    "active step",
    "tool tail",
    "extra input",
    "wrong response",
    "wrong turn count",
    "wrong conversation",
  ])("preserves the native failure with %s", async (reason) => {
    const f = await fixture();
    try {
      f.fresh();
      let candidate = result;
      let response = "Fresh response";
      if (reason === "new error step") f.step(4, 17, ERROR);
      if (reason === "new generator error")
        f.db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(Buffer.from(ERROR));
      if (reason === "new executor error")
        f.db.prepare("INSERT INTO executor_metadata VALUES (1, ?)").run(Buffer.from(ERROR));
      if (reason === "different generator error")
        f.db
          .prepare("INSERT INTO gen_metadata VALUES (1, ?)")
          .run(Buffer.from([0x2a, 3, 0x62, 0x61, 0x64]));
      if (reason === "different executor error")
        f.db
          .prepare("INSERT INTO executor_metadata VALUES (1, ?)")
          .run(Buffer.from([0x62, 3, 0x62, 0x61, 0x64]));
      if (reason === "invalid metadata")
        f.db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(Buffer.from([0x2a, 8, 1]));
      if (reason === "step error details")
        f.db.prepare("UPDATE steps SET error_details=? WHERE idx=3").run(Buffer.from("Failure"));
      if (reason === "active step") f.db.prepare("UPDATE steps SET status=2 WHERE idx=3").run();
      if (reason === "tool tail") f.step(4, 132, "Tool finished");
      if (reason === "extra input") {
        f.step(4, 14, "Another input");
        f.step(5, 15, "Fresh response");
      }
      if (reason === "wrong response") response = "Previous response";
      if (reason === "wrong turn count") candidate = { ...result, num_turns: 1 };
      if (reason === "wrong conversation")
        candidate = { ...result, conversation_id: "00000000-0000-4000-8000-000000000002" };
      expect(await isHistoricalNativeError(candidate, f.boundary, response, f.home)).toBe(false);
    } finally {
      await f.dispose();
    }
  });

  it("does not infer recovery from a partial reply or an unavailable native format", async () => {
    const f = await fixture();
    try {
      expect(await isHistoricalNativeError(result, f.boundary, "Fresh response", f.home)).toBe(
        false,
      );
      f.fresh();
      expect(await isHistoricalNativeError(result, null, "Fresh response", f.home)).toBe(false);
      expect(await isHistoricalNativeError(result, f.boundary, "", f.home)).toBe(false);
      expect(
        await isHistoricalNativeError(
          { ...result, error: "Different failure" },
          f.boundary,
          "Fresh response",
          f.home,
        ),
      ).toBe(false);
      f.db.exec("DROP TABLE gen_metadata");
      expect(await isHistoricalNativeError(result, f.boundary, "Fresh response", f.home)).toBe(
        false,
      );
    } finally {
      await f.dispose();
    }
  });

  it.each([false, true])(
    "projects a resumed CLI result with fresh error=%s using native Turn evidence",
    async (freshError) => {
      const f = await fixture();
      const script = `
if (process.argv.includes("models")) {
  console.log("gemini-3.7-flash-high\\tGemini 3.7 Flash High");
} else if (process.argv.includes("--input-format")) {
  const {DatabaseSync} = require("node:sqlite");
  const db = new DatabaseSync(${JSON.stringify(nativeConversationDbPath(ID, f.home))});
  const step = db.prepare("INSERT INTO steps VALUES (?, ?, 3, NULL, ?)");
  step.run(2,14,Buffer.from("Current input"));
  step.run(3,15,Buffer.from("Fresh response"));
  if (${freshError}) step.run(4,17,Buffer.from(${JSON.stringify(ERROR)}));
  db.close();
  for (const event of [
    {event:"init",conversation_id:${JSON.stringify(ID)}},
    {event:"step_update",step_update:{conversation_id:${JSON.stringify(ID)},step_index:2,step_type:"user_input",state:"DONE"}},
    {event:"step_update",step_update:{conversation_id:${JSON.stringify(ID)},step_index:3,step_type:"agent_response",state:"DONE",text:"Fresh response"}},
    {event:"result",result:${JSON.stringify({ ...result, response: freshError ? "Fresh response" : "Old summary response" })}}
  ]) console.log(JSON.stringify(event));
}
`;
      const jsFile = path.join(f.home, "agy.cjs");
      await writeFile(jsFile, script);
      const command = path.join(f.home, process.platform === "win32" ? "agy.cmd" : "agy");
      if (process.platform === "win32")
        await writeFile(command, `@"${process.execPath}" "${jsFile}" %*\r\n`);
      else {
        await writeFile(command, `#!${process.execPath}\n${script}`);
        await chmod(command, 0o755);
      }
      const adapter = new AntigravityAdapter({
        command,
        environment: {
          ...process.env,
          USERPROFILE: f.home,
          HOME: f.home,
          CODEXHOST_DATA_DIR: f.home,
        },
      });
      try {
        const opened = await adapter.open({
          kind: "resume",
          cwd: f.home,
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "antigravity",
            nativeSessionId: ID,
            formatVersion: 1,
          }),
        });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();
        const accepted = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("native-result-resume"),
          input: [{ type: "text", text: "Current input" }],
        });
        if (!accepted.ok) throw new Error(accepted.error.message);
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw new Error("Missing terminal event");
          if (next.value.kind !== "event" || next.value.event.type !== "turn.completed") continue;
          expect(next.value.event.outcome, JSON.stringify(next.value.event.outcome)).toMatchObject({
            status: freshError ? "failed" : "succeeded",
          });
          break;
        }
        const snapshot = await session.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        expect(
          snapshot.value.turns.at(-1)?.items.findLast(({ item }) => item.type === "agentMessage")
            ?.item,
        ).toMatchObject({ text: "Fresh response" });
        expect(f.db.prepare("SELECT step_type FROM steps WHERE idx=1").get()?.step_type).toBe(17);
      } finally {
        await adapter.close();
        await f.dispose();
      }
    },
  );
});
