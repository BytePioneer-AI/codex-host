import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAdapter, formatRecoveredHistoryContext } from "../src/antigravity-adapter.js";
import {
  ensureNativeConversationDb,
  nativeConversationDbPath,
  seedNativeConversationDb,
} from "../src/fork.js";
import { AntigravityHistory } from "../src/history.js";
import type * as ForkModule from "../src/fork.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("../src/fork.js", async (original) => {
  const actual = await original<typeof ForkModule>();
  return { ...actual, ensureNativeConversationDb: vi.fn(actual.ensureNativeConversationDb) };
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-boundaries-"));
  const script = path.join(home, "agy.cjs");
  await writeFile(
    script,
    `if (process.argv.includes("models")) {
  console.log("gemini-3.7-flash\\tGemini 3.7 Flash");
  process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  const id = process.argv[process.argv.indexOf("--conversation") + 1];
  console.log(JSON.stringify({ event: "init", conversation_id: id }));
  console.log(JSON.stringify({ event: "result", result: {
    conversation_id: id, status: "SUCCESS", num_turns: 1, response: "answer"
  } }));
  process.exit(0);
});
`,
  );
  const command = path.join(home, process.platform === "win32" ? "agy.cmd" : "agy");
  await writeFile(
    command,
    process.platform === "win32"
      ? `@node "${script}" %*\r\n`
      : `#!/usr/bin/env node\n${await readFile(script, "utf8")}`,
  );
  if (process.platform !== "win32") await chmod(command, 0o755);
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEXHOST_DATA_DIR: home,
    CODEXHOST_THREAD_ID: "source",
  };
  const adapter = new AntigravityAdapter({ command, environment });
  const nativeRef = nativeSessionRefSchema.parse({
    harnessId: "antigravity",
    nativeSessionId: randomUUID(),
    formatVersion: 1,
  });
  return {
    home,
    environment,
    adapter,
    nativeRef,
    async cleanup() {
      await adapter.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("Antigravity recovered history boundaries", () => {
  it.each([
    ["fork", 1, false],
    ["rollbackLastTurn", 1, false],
    ["fork", 4, false],
    ["rollbackLastTurn", 4, false],
    ["fork", 3, true],
    ["rollbackLastTurn", 3, true],
    ["fork", 0, true],
    ["rollbackLastTurn", 0, true],
  ] as const)("%s: native=%i, sidecar=3", async (kind, nativeTurns, allowed) => {
    const f = await fixture();
    try {
      const history = await AntigravityHistory.open({
        environment: f.environment,
        nativeSessionId: f.nativeRef.nativeSessionId,
      });
      for (let turn = 1; turn <= 3; turn++) {
        history.append({
          nativeTurnRef: { ...f.nativeRef, nativeTurnKey: `turn:${turn}` },
          checkpoint: { ...f.nativeRef, checkpointId: `turn:${turn}` },
          turnInput: [{ type: "text", text: `question ${turn}` }],
          items: [],
          outcome: { status: "succeeded" },
        });
      }
      await history.flush();
      expect(await seedNativeConversationDb(f.nativeRef.nativeSessionId, f.home)).toBe(true);
      const sourcePath = nativeConversationDbPath(f.nativeRef.nativeSessionId, f.home);
      const db = new DatabaseSync(sourcePath);
      try {
        const insert = db.prepare(
          "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
        );
        for (let turn = 0; turn < nativeTurns; turn++) {
          const input =
            nativeTurns === 1
              ? `${formatRecoveredHistoryContext(history.snapshot().slice(0, 2))}question 3`
              : `question ${turn + 1}`;
          insert.run(turn * 2, 14, Buffer.from(input));
          insert.run(turn * 2 + 1, 15, Buffer.from(`answer ${turn + 1}`));
        }
      } finally {
        db.close();
      }
      const before = await readFile(sourcePath);
      const sourceHistoryPath = path.join(f.home, "antigravity-history", "source.json");
      const historyBefore = await readFile(sourceHistoryPath);
      const result = await f.adapter.open({
        cwd: f.home,
        sourceRef: f.nativeRef,
        ...(kind === "fork"
          ? { kind, checkpoint: { ...f.nativeRef, checkpointId: "turn:2" } }
          : { kind }),
        environment: { CODEXHOST_THREAD_ID: "derived" },
      });
      if (!allowed) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "unsupported", retryable: false },
        });
        if (result.ok) throw new Error("Expected a native boundary mismatch to be rejected");
        expect(result.error.message).toContain(`${nativeTurns} user_input boundaries`);
        expect(await readdir(path.dirname(sourcePath))).toEqual([path.basename(sourcePath)]);
        expect(await readdir(path.dirname(sourceHistoryPath))).toEqual(["source.json"]);
      } else {
        if (!result.ok) throw new Error(result.error.message);
        const snapshot = await result.value.readSnapshot();
        expect(snapshot.ok && snapshot.value.turns).toHaveLength(2);
        const derivedId = result.value.initialState.nativeRef?.nativeSessionId;
        if (!derivedId) throw new Error("Missing derived native identity");
        const derived = new DatabaseSync(nativeConversationDbPath(derivedId, f.home));
        try {
          expect(derived.prepare("SELECT count(*) AS n FROM steps").get()?.n).toBe(
            nativeTurns === 0 ? 0 : 4,
          );
        } finally {
          derived.close();
        }
        await result.value.close();
      }
      expect(await readFile(sourcePath)).toEqual(before);
      expect(await readFile(sourceHistoryPath)).toEqual(historyBefore);
    } finally {
      await f.cleanup();
    }
  });
});

describe("Antigravity native recovery startup lifecycle", () => {
  it.each([false, true])("holds startup occupancy, close during ensure=%s", async (close) => {
    const f = await fixture();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let starting: Promise<unknown> | undefined;
    try {
      const opened = await f.adapter.open({ kind: "resume", cwd: f.home, nativeRef: f.nativeRef });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      vi.mocked(spawn).mockClear();
      vi.mocked(ensureNativeConversationDb).mockImplementationOnce(async () => {
        entered.resolve(undefined);
        await release.promise;
        return { seeded: false, emptySteps: false };
      });
      const executing = session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("recovering"),
        input: [{ type: "text", text: "continue" }],
      });
      starting = executing;
      await entered.promise;
      if (close) {
        await session.close();
        release.resolve(undefined);
        expect(await executing).toMatchObject({ ok: false, error: { code: "invalidState" } });
        expect(spawn).not.toHaveBeenCalled();
      } else {
        expect(
          await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("overlapping"),
            input: [{ type: "text", text: "another message" }],
          }),
        ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
        expect(spawn).not.toHaveBeenCalled();
        release.resolve(undefined);
        expect(await executing).toMatchObject({ ok: true });
        expect(spawn).toHaveBeenCalledTimes(1);
        await session.close();
      }
    } finally {
      release.resolve(undefined);
      await starting;
      await f.cleanup();
    }
  });
});
