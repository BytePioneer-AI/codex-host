import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HarnessOutput, HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAdapter } from "../src/index.js";

const nativeError = "API error (attempt 1): request failed: EOF";
const turnId = hostTurnIdSchema.parse("turn-recovery-guard");

async function fixture(options: {
  finishedReason?: string;
  stderrTimeout?: boolean;
  settling?: boolean;
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-recovery-guard-"));
  const home = path.join(directory, "home");
  const cwd = path.join(directory, "workspace");
  const dbDir = path.join(home, ".gemini", "antigravity-cli", "conversations");
  await mkdir(cwd);
  await mkdir(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, "conv-guard.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)",
    );
    const insert = db.prepare(
      "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
    );
    insert.run(0, 14, 3, Buffer.from("input"));
    insert.run(1, 17, 3, Buffer.from(nativeError));
    insert.run(2, 15, options.settling ? 2 : 3, Buffer.from("reply"));
  } finally {
    db.close();
  }
  const result = {
    conversation_id: "conv-guard",
    status: "ERROR",
    error: nativeError,
    response: "done",
    num_turns: 1,
    ...(options.finishedReason ? { finished_reason: options.finishedReason } : {}),
  };
  const script = `
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\n");
  process.exit(0);
}
if (!process.argv.includes("--input-format")) process.exit(0);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "init", conversation_id: "conv-guard", init: { permission_mode: "default" } });
const finish = () => emit({ event: "result", result: ${JSON.stringify(result)} });
${options.stderrTimeout ? 'process.stderr.write("error: print timeout after 30m0s\\n", finish);' : "finish();"}
`;
  const jsPath = path.join(directory, "agy.cjs");
  await writeFile(jsPath, script);
  const command = path.join(directory, process.platform === "win32" ? "agy.cmd" : "agy");
  await writeFile(
    command,
    process.platform === "win32" ? `@node "${jsPath}" %*\r\n` : `#!/usr/bin/env node\n${script}`,
  );
  if (process.platform !== "win32") await chmod(command, 0o755);
  const adapter = new AntigravityAdapter({
    command,
    environment: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEXHOST_DATA_DIR: path.join(directory, "data"),
    },
  });
  return {
    adapter,
    cwd,
    settle() {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("UPDATE steps SET status = 3 WHERE idx = 2");
      } finally {
        db.close();
      }
    },
    async cleanup() {
      await adapter.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function completed(
  session: HarnessSession,
): Promise<Extract<HostEvent, { type: "turn.completed" }>> {
  for await (const output of session.outputs) {
    if (output.kind === "event" && output.event.type === "turn.completed") return output.event;
  }
  throw new Error("Session ended without turn.completed");
}

async function start(session: HarnessSession) {
  expect(
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "go" }] }),
  ).toMatchObject({ ok: true });
}

describe("Antigravity recovery terminal guards", () => {
  it.each([
    { finishedReason: "print_timeout" },
    { finishedReason: "interrupted" },
    { stderrTimeout: true },
  ])("keeps a recoverable DB failed with explicit truncation %j", async (options) => {
    const test = await fixture(options);
    try {
      const opened = await test.adapter.open({ kind: "create", cwd: test.cwd });
      if (!opened.ok) throw new Error(opened.error.message);
      const outcome = completed(opened.value);
      await start(opened.value);
      expect((await outcome).outcome).toMatchObject({ status: "failed" });
    } finally {
      await test.cleanup();
    }
  });

  it.each([true, false])(
    "publishes cancelled when cancellation arrives during recovery (recovered=%s)",
    async (recovered) => {
      const test = await fixture({ settling: true });
      const outputs: HarnessOutput[] = [];
      try {
        const opened = await test.adapter.open({ kind: "create", cwd: test.cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const collecting = (async () => {
          for await (const output of session.outputs) outputs.push(output);
        })();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const timer = vi.spyOn(globalThis, "setTimeout");
        await start(session);
        // The real recovery query has read the RUNNING reply and is waiting to reread the DB.
        await vi.waitFor(() =>
          expect(timer.mock.calls.some(([, delay]) => delay === 150)).toBe(true),
        );
        expect(
          outputs.some(
            (output) => output.kind === "event" && output.event.type === "turn.completed",
          ),
        ).toBe(false);
        expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({
          ok: true,
          value: { cancellationRequested: true },
        });
        if (recovered) test.settle();
        await vi.advanceTimersByTimeAsync(300);
        const completions = outputs.flatMap((output) =>
          output.kind === "event" && output.event.type === "turn.completed" ? [output.event] : [],
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({
          outcome: { status: "cancelled", reason: "Cancelled by user" },
          nativeTurnRef: { nativeSessionId: "conv-guard" },
        });
        await vi.advanceTimersByTimeAsync(3_000);
        vi.useRealTimers();
        await session.close();
        await collecting;
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await test.cleanup();
      }
    },
  );
});
