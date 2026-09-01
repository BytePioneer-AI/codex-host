import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { CursorAdapter } from "../src/index.js";

const RUN_REAL = process.env.CODEXHOST_RUN_CURSOR_ADAPTER_REAL === "1";
const REAL_TIMEOUT_MS = 90_000;

class OutputCollector {
  readonly outputs: HarnessOutput[] = [];
  readonly consuming: Promise<void>;

  constructor(session: HarnessSession) {
    this.consuming = this.#consume(session);
  }

  waitFor(predicate: (output: HarnessOutput) => boolean): Promise<HarnessOutput> {
    const existing = this.outputs.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const found = this.outputs.find(predicate);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }
        if (Date.now() - started > 60_000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for real Cursor output"));
        }
      }, 50);
    });
  }

  async #consume(session: HarnessSession): Promise<void> {
    for await (const output of session.outputs) this.outputs.push(output);
  }
}

describe.skipIf(!RUN_REAL)("CursorAdapter real CLI smoke", () => {
  it(
    "creates, streams, and resumes an ACP Session in an empty workspace",
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "codexhost-cursor-real-"));
      const adapter = new CursorAdapter({ closeTimeoutMs: 8_000, commandTimeoutMs: 20_000 });
      let resumedAdapter: CursorAdapter | null = null;
      try {
        const inspection = await adapter.inspect({ cwd, refresh: true });
        expect(inspection.status).toBe("ready");
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(`Cursor Session failed to open: ${opened.error.message}`);
        const nativeRef = opened.value.initialState.nativeRef;
        if (!nativeRef) throw new Error("Cursor Session has no Native Session identity");
        const collector = new OutputCollector(opened.value);
        const result = await opened.value.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("00000000-0000-4000-8000-0000000000aa"),
          input: [{ type: "text", text: "Reply with the single word pong." }],
        });
        expect(result.ok).toBe(true);
        await collector.waitFor(
          (output) => output.kind === "event" && output.event.type === "turn.completed",
        );
        await opened.value.close();
        await collector.consuming;

        resumedAdapter = new CursorAdapter({ closeTimeoutMs: 8_000, commandTimeoutMs: 20_000 });
        const resumed = await resumedAdapter.open({ kind: "resume", cwd, nativeRef });
        if (!resumed.ok)
          throw new Error(`Cursor Session failed to resume: ${resumed.error.message}`);
        const snapshot = await resumed.value.readSnapshot();
        if (!snapshot.ok)
          throw new Error(`Cursor history failed to load: ${snapshot.error.message}`);
        expect(snapshot.value.turns.length).toBeGreaterThan(0);
        expect(snapshot.value.turns.at(-1)?.input).toEqual([
          { type: "text", text: "Reply with the single word pong." },
        ]);
        await resumed.value.close();
      } finally {
        await resumedAdapter?.close();
        await adapter.close();
      }
    },
    REAL_TIMEOUT_MS,
  );
});
