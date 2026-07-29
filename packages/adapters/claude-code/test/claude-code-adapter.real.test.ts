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
    "round-trips native AskUserQuestion and continues the Session",
    async () => {
      const workspace = path.resolve(".codexhost", "claude-question-real", "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const adapter = new ClaudeCodeAdapter({ closeTimeoutMs: 10_000 });
      try {
        const opened = await adapter.open({ kind: "create", cwd: workspace });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const collector = new OutputCollector(session);
        const questionTurnId = turnId("11");
        await startTurn(
          session,
          questionTurnId,
          [
            "Use AskUserQuestion to ask exactly one question.",
            "Use header Path and exactly two options named Alpha and Beta.",
            "After receiving the answer, reply with exactly CLAUDE_QUESTION_DONE.",
          ].join(" "),
        );
        const questionOutput = await collector.waitFor(
          (output) => output.kind === "interaction" && output.interaction.turnId === questionTurnId,
        );
        if (questionOutput.kind !== "interaction") throw new Error("Question was not emitted");
        const question = questionOutput.interaction.questions[0];
        if (!question || question.type !== "choice") throw new Error("Choice was not emitted");
        const answer = question.options[0]?.value;
        if (!answer) throw new Error("Question has no declared answer");
        await expect(
          session.execute({
            type: "interaction.respond",
            interactionId: questionOutput.interaction.interactionId,
            response: { type: "question", answers: { [question.id]: [answer] } },
          }),
        ).resolves.toEqual({ ok: true, value: { accepted: true } });
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "interaction.closed" &&
              output.event.interactionId === questionOutput.interaction.interactionId,
          ),
        ).resolves.toMatchObject({ event: { reason: "responded" } });
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === questionTurnId,
          ),
        ).resolves.toMatchObject({ event: { outcome: { status: "succeeded" } } });

        const continuationTurnId = turnId("12");
        await startTurn(
          session,
          continuationTurnId,
          "Reply with exactly CLAUDE_QUESTION_CONTINUED.",
        );
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

  it(
    "cancels a pending native AskUserQuestion before the Turn terminal",
    async () => {
      const workspace = path.resolve(".codexhost", "claude-question-cancel-real", "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const adapter = new ClaudeCodeAdapter({ closeTimeoutMs: 10_000 });
      try {
        const opened = await adapter.open({ kind: "create", cwd: workspace });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const collector = new OutputCollector(session);
        const questionTurnId = turnId("21");
        await startTurn(
          session,
          questionTurnId,
          [
            "Use AskUserQuestion to ask exactly one question.",
            "Use header Continue and exactly two options named Yes and No.",
            "Wait for the answer.",
          ].join(" "),
        );
        const questionOutput = await collector.waitFor(
          (output) => output.kind === "interaction" && output.interaction.turnId === questionTurnId,
        );
        if (questionOutput.kind !== "interaction") throw new Error("Question was not emitted");
        await expect(
          session.execute({ type: "turn.cancel", turnId: questionTurnId }),
        ).resolves.toEqual({ ok: true, value: { cancellationRequested: true } });
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "interaction.closed" &&
              output.event.interactionId === questionOutput.interaction.interactionId,
          ),
        ).resolves.toMatchObject({ event: { reason: "cancelled" } });
        await expect(
          collector.waitFor(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === questionTurnId,
          ),
        ).resolves.toMatchObject({ event: { outcome: { status: "cancelled" } } });

        await session.close();
        await collector.consuming;
      } finally {
        await adapter.close();
      }
    },
    REAL_TIMEOUT_MS,
  );

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
