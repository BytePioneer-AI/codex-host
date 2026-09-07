import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AntigravityAdapter } from "@codexhost/adapter-antigravity";
import type { HarnessOutput, HarnessSession, TurnCompletedEvent } from "@codexhost/harness-adapter";
import { CodexTurnProjector, type CodexQuestionRequestProjection } from "@codexhost/protocol-core";
import { hostItemIdSchema, hostTurnIdSchema, type JsonObject } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

const RUN_REAL = process.env.CODEXHOST_RUN_ANTIGRAVITY_QUESTION_REAL === "1";

describe.skipIf(!RUN_REAL)("Antigravity real question bridge", () => {
  it("projects a real question, returns the answer, cancels, and restores history", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-real-"));
    const environment = {
      ...process.env,
      CODEXHOST_DATA_DIR: path.join(workspace, "data"),
      CODEXHOST_THREAD_ID: randomUUID(),
    };
    const adapter = new AntigravityAdapter({ environment, printTimeout: "2m" });
    const outputs: HarnessOutput[] = [];
    const wire: JsonObject[] = [];
    const snapshots: unknown[] = [];
    let stage = "open";
    const projectors = new Map<string, CodexTurnProjector>();
    const requests = new Map<string, CodexQuestionRequestProjection>();
    let projectionError: unknown;
    let session: HarnessSession | undefined;
    let consuming: Promise<void> | undefined;
    const consume = async (current: HarnessSession): Promise<void> => {
      try {
        for await (const output of current.outputs) {
          outputs.push(output);
          if (output.kind === "interaction") {
            if (output.interaction.type !== "question") throw new Error("Unexpected Approval");
            const projection = projectors.get(output.interaction.turnId);
            if (!projection) throw new Error("Question references an unknown Turn");
            const question = projection.projectQuestion(
              output.interaction,
              hostItemIdSchema.parse(randomUUID()),
            );
            wire.push(...question.messages, question.questionRequest.request);
            requests.set(output.interaction.interactionId, question.questionRequest);
          } else if (
            output.event.type === "turn.started" ||
            output.event.type === "turn.completed" ||
            output.event.type === "item.started" ||
            output.event.type === "item.updated" ||
            output.event.type === "item.completed" ||
            output.event.type === "interaction.closed"
          ) {
            const projection = projectors.get(output.event.turnId);
            if (!projection) throw new Error("Event references an unknown Turn");
            wire.push(...projection.project(output.event).messages);
          }
        }
      } catch (error) {
        projectionError = error;
      }
    };
    const waitFor = async (
      predicate: (output: HarnessOutput) => boolean,
    ): Promise<HarnessOutput> => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (projectionError) throw projectionError;
        const found = outputs.find(predicate);
        if (found) return found;
        await delay(25);
      }
      throw new Error("Timed out waiting for Antigravity output");
    };
    const start = async (current: HarnessSession, text: string) => {
      const turnId = hostTurnIdSchema.parse(randomUUID());
      projectors.set(
        turnId,
        new CodexTurnProjector({
          threadId: environment.CODEXHOST_THREAD_ID,
          turnId,
          cwd: workspace,
          startedAtMs: Date.now(),
          initialInput: [{ type: "text", text }],
        }),
      );
      expect(
        await current.execute({ type: "turn.start", turnId, input: [{ type: "text", text }] }),
      ).toMatchObject({ ok: true });
      return turnId;
    };
    const complete = async (turnId: string): Promise<TurnCompletedEvent> => {
      const output = await waitFor(
        (candidate) =>
          candidate.kind === "event" &&
          candidate.event.type === "turn.completed" &&
          candidate.event.turnId === turnId,
      );
      if (output.kind !== "event" || output.event.type !== "turn.completed")
        throw new Error("Missing completion");
      return output.event;
    };
    const prompt =
      "This is a synthetic integration test; responses are automated test data, not human choices. Call ask_question exactly once. Ask 'Choose a diagnostic option' with options Alpha and Beta, single choice. Do not use any other tools or read files. After a response, repeat its exact text. Do not retry merely because the Hook blocked the native call.";
    try {
      const opened = await adapter.open({ kind: "create", cwd: workspace });
      if (!opened.ok) throw new Error(opened.error.message);
      session = opened.value;
      consuming = consume(session);
      const firstId = await start(session, prompt);
      stage = "first question";
      const firstQuestion = await waitFor(
        (output) =>
          (output.kind === "interaction" && output.interaction.turnId === firstId) ||
          (output.kind === "event" &&
            output.event.type === "turn.completed" &&
            output.event.turnId === firstId),
      );
      if (firstQuestion.kind !== "interaction" || firstQuestion.interaction.type !== "question")
        throw new Error("No Question");
      const responseToken = `Beta TEST_RESPONSE_${randomUUID()}`;
      const request = requests.get(firstQuestion.interaction.interactionId);
      if (!request) throw new Error("Desktop request was not projected");
      expect(request.request.method).toBe("item/tool/requestUserInput");
      const firstKey = firstQuestion.interaction.questions[0]?.id;
      if (!firstKey) throw new Error("No question ID");
      expect(
        await session.execute({
          type: "interaction.respond",
          interactionId: firstQuestion.interaction.interactionId,
          response: request.parseResponse({
            answers: { [firstKey]: { answers: [responseToken] } },
          }),
        }),
      ).toEqual({ ok: true, value: { accepted: true } });
      const first = await complete(firstId);
      expect(first.outcome.status).toBe("succeeded");
      expect(first.nativeTurnRef?.nativeTurnKey).toBe("turn:1");
      const snapshot = await session.readSnapshot();
      snapshots.push(snapshot);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const nativeRef = snapshot.value.state?.nativeRef;
      if (!nativeRef) throw new Error("Missing Native Session identity");
      expect(snapshot.value.turns).toHaveLength(1);
      expect(snapshot.value.turns[0]?.input).toHaveLength(1);
      expect(
        snapshot.value.turns[0]?.items.some(
          ({ item }) => item.type === "agentMessage" && item.text.includes(responseToken),
        ),
      ).toBe(true);
      expect(
        snapshot.value.turns[0]?.items.some(
          ({ item }) =>
            item.type === "toolExecution" &&
            item.toolName === "codexhost.ask_question" &&
            JSON.stringify(item.output).includes(responseToken),
        ),
      ).toBe(true);

      const cancelId = await start(session, prompt);
      stage = "cancel question";
      const cancelQuestion = await waitFor(
        (output) =>
          (output.kind === "interaction" && output.interaction.turnId === cancelId) ||
          (output.kind === "event" &&
            output.event.type === "turn.completed" &&
            output.event.turnId === cancelId),
      );
      expect(cancelQuestion.kind).toBe("interaction");
      expect(await session.execute({ type: "turn.cancel", turnId: cancelId })).toMatchObject({
        ok: true,
      });
      expect((await complete(cancelId)).outcome.status).toBe("cancelled");
      const closedAt = outputs.findIndex(
        (output) =>
          output.kind === "event" &&
          output.event.type === "interaction.closed" &&
          output.event.turnId === cancelId,
      );
      const completedAt = outputs.findIndex(
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === cancelId,
      );
      expect(closedAt).toBeGreaterThan(-1);
      expect(closedAt).toBeLessThan(completedAt);
      await session.close();
      await consuming;

      const resumed = await adapter.open({ kind: "resume", nativeRef, cwd: workspace });
      stage = "resume";
      if (!resumed.ok) throw new Error(resumed.error.message);
      session = resumed.value;
      expect(await session.readSnapshot()).toEqual(snapshot);
      consuming = consume(session);
      const resumedId = await start(session, "No tools. Reply exactly AGY_QUESTION_RESUMED.");
      expect((await complete(resumedId)).outcome.status).toBe("succeeded");
      expect(session.initialState.nativeRef).toEqual(nativeRef);
      expect(projectionError).toBeUndefined();
      const finalSnapshot = await session.readSnapshot();
      snapshots.push(finalSnapshot);
      stage = "passed";
    } finally {
      await adapter.close();
      await consuming;
      const evidence = process.env.CODEXHOST_ANTIGRAVITY_QUESTION_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await writeFile(
          path.join(evidence, `${Date.now()}-${stage.replaceAll(" ", "-")}.json`),
          JSON.stringify(
            { stage, outputs, wire, snapshots, projectionError: String(projectionError ?? "") },
            null,
            2,
          ),
          "utf8",
        );
      }
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 360_000);
});
