import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { ClaudeCodeAdapter } from "../src/index.js";

const RUN_REAL = process.env.CODEXHOST_RUN_CLAUDE_ADAPTER_REAL === "1";
const REAL_TIMEOUT_MS = 180_000;

class OutputCollector {
  readonly outputs: HarnessOutput[] = [];
  readonly #session: HarnessSession;
  readonly #waiters: Array<{
    predicate: (output: HarnessOutput) => boolean;
    resolve(output: HarnessOutput): void;
  }> = [];
  readonly consuming: Promise<void>;

  constructor(session: HarnessSession) {
    this.#session = session;
    this.consuming = this.#consume();
  }

  waitFor(predicate: (output: HarnessOutput) => boolean): Promise<HarnessOutput> {
    const existing = this.outputs.find(predicate);
    if (existing) return Promise.resolve(existing);
    return Promise.race([
      new Promise<HarnessOutput>((resolve) => this.#waiters.push({ predicate, resolve })),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for real Claude output")), 120_000),
      ),
    ]);
  }

  async #consume(): Promise<void> {
    for await (const output of this.#session.outputs) {
      this.outputs.push(output);
      for (const waiter of [...this.#waiters]) {
        if (!waiter.predicate(output)) continue;
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(output);
      }
    }
  }
}

function turnId(suffix: string) {
  return hostTurnIdSchema.parse(`00000000-0000-4000-8000-${suffix.padStart(12, "0")}`);
}

async function startTurn(session: HarnessSession, id: ReturnType<typeof turnId>, text: string) {
  const result = await session.execute({
    type: "turn.start",
    turnId: id,
    input: [{ type: "text", text }],
  });
  expect(result).toMatchObject({ ok: true });
}

describe.skipIf(!RUN_REAL)("ClaudeCodeAdapter real SDK integration", () => {
  it(
    "runs text, cancels authoritatively, continues the Session, and closes",
    async () => {
      const workspace = path.resolve(".codexhost", "claude-adapter-real", "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const prompts = {
        first: "Reply with exactly CODEXHOST_CLAUDE_ADAPTER_OK.",
        cancel: "Write the integers from 1 through 10000, one integer per line.",
        continuation: "Reply with exactly CODEXHOST_CLAUDE_ADAPTER_CONTINUED.",
      };
      await fs.writeFile(
        path.join(workspace, "prompts.local.json"),
        `${JSON.stringify(prompts, null, 2)}\n`,
        "utf8",
      );

      const adapter = new ClaudeCodeAdapter({ closeTimeoutMs: 10_000 });
      try {
        const opened = await adapter.open({ kind: "create", cwd: workspace });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const collector = new OutputCollector(session);

        const firstTurnId = turnId("1");
        await startTurn(session, firstTurnId, prompts.first);
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === firstTurnId,
          ),
        ).resolves.toMatchObject({ event: { outcome: { status: "succeeded" } } });
        expect(
          collector.outputs.some(
            (output) =>
              output.kind === "event" &&
              output.event.type === "item.updated" &&
              output.event.turnId === firstTurnId &&
              output.event.update.type === "text.append",
          ),
        ).toBe(true);

        const cancelledTurnId = turnId("2");
        await startTurn(session, cancelledTurnId, prompts.cancel);
        const cancelled = await session.execute({
          type: "turn.cancel",
          turnId: cancelledTurnId,
        });
        expect(cancelled).toMatchObject({ ok: true });
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === cancelledTurnId,
          ),
        ).resolves.toMatchObject({ event: { outcome: { status: "cancelled" } } });

        const continuationTurnId = turnId("3");
        await startTurn(session, continuationTurnId, prompts.continuation);
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === continuationTurnId,
          ),
        ).resolves.toMatchObject({ event: { outcome: { status: "succeeded" } } });

        await session.close();
        await collector.consuming;
      } finally {
        await adapter.close();
      }
    },
    REAL_TIMEOUT_MS,
  );
});
