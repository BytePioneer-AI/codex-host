import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AntigravityAdapter } from "@codexhost/adapter-antigravity";
import type {
  HarnessOutput,
  HarnessSession,
  HostApprovalInteraction,
} from "@codexhost/harness-adapter";
import { CodexTurnProjector, type CodexApprovalRequestProjection } from "@codexhost/protocol-core";
import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

const RUN_REAL = process.env.CODEXHOST_RUN_ANTIGRAVITY_APPROVAL_REAL === "1";

describe.skipIf(!RUN_REAL)("Antigravity real tool approval bridge", () => {
  it("executes only after Desktop acceptance and blocks declined/cancelled file operations", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-approval-"));
    const environment = {
      ...process.env,
      CODEXHOST_DATA_DIR: path.join(workspace, "data"),
      CODEXHOST_THREAD_ID: randomUUID(),
    };
    const adapter = new AntigravityAdapter({ environment, printTimeout: "2m" });
    const outputs: HarnessOutput[] = [];
    const wire: JsonObject[] = [];
    const projectors = new Map<string, CodexTurnProjector>();
    const approvals = new Map<string, CodexApprovalRequestProjection>();
    let session: HarnessSession | undefined;
    let consume: Promise<void> | undefined;
    let error: unknown;
    let stage = "open";
    const exists = async (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );
    const wait = async (predicate: (output: HarnessOutput) => boolean) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (error) throw error;
        const found = outputs.find(predicate);
        if (found) return found;
        await delay(25);
      }
      throw new Error(`Timed out at ${stage}`);
    };
    try {
      const opened = await adapter.open({
        kind: "create",
        cwd: workspace,
        model: harnessModelRefSchema.parse({ id: "gemini-3.8-flash-high" }),
        permissionModeId: harnessPermissionModeIdSchema.parse("desktop-approvals"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      session = opened.value;
      consume = (async () => {
        for await (const output of opened.value.outputs) {
          outputs.push(output);
          if (output.kind === "interaction") {
            if (output.interaction.type !== "approval") throw new Error("Unexpected Question");
            const projector = projectors.get(output.interaction.turnId);
            if (!projector) throw new Error("Missing Turn");
            const approval = projector.projectApproval(
              output.interaction,
              "Antigravity CLI",
            ).approvalRequest;
            wire.push(approval.request);
            approvals.set(output.interaction.interactionId, approval);
          } else if ("turnId" in output.event) {
            const projector = projectors.get(output.event.turnId);
            if (projector && output.event.type !== "turn.autonomous.started") {
              wire.push(...projector.project(output.event).messages);
            }
          }
        }
      })().catch((value: unknown) => {
        error = value;
      });

      for (const action of ["accept", "decline", "cancel"] as const) {
        stage = action;
        const file = path.join(workspace, `${action}.txt`);
        const token = `APPROVAL_${action}_${randomUUID()}`;
        const turnId = hostTurnIdSchema.parse(randomUUID());
        const input = [
          {
            type: "text" as const,
            text: `Synthetic integration fixture. Use write_to_file exactly ONCE to create ${file} containing exactly ${token}. No other tools or subagents. No ArtifactMetadata is needed. If blocked or denied, do not retry or use another method; just report the denial.`,
          },
        ];
        projectors.set(
          turnId,
          new CodexTurnProjector({
            threadId: environment.CODEXHOST_THREAD_ID,
            turnId,
            cwd: workspace,
            startedAtMs: Date.now(),
            initialInput: input,
          }),
        );
        const started = await session.execute({ type: "turn.start", turnId, input });
        if (!started.ok) throw new Error(started.error.message);
        const request = await wait(
          (output) =>
            (output.kind === "interaction" && output.interaction.turnId === turnId) ||
            (output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === turnId),
        );
        if (request.kind !== "interaction") throw new Error("No tool Approval was emitted");
        const interaction = request.interaction as HostApprovalInteraction;
        expect(interaction.title).toContain("write_to_file");
        await delay(150);
        expect(await exists(file)).toBe(false);
        const approval = approvals.get(interaction.interactionId);
        if (!approval) throw new Error("No Desktop Approval request");
        expect(approval.request.method).toBe("mcpServer/elicitation/request");
        if (action === "cancel") {
          expect(await session.execute({ type: "turn.cancel", turnId })).toMatchObject({
            ok: true,
          });
        } else {
          expect(
            await session.execute({
              type: "interaction.respond",
              interactionId: interaction.interactionId,
              response: approval.parseResponse(
                action === "accept" ? { action, content: {} } : { action },
              ),
            }),
          ).toMatchObject({ ok: true });
        }
        const completed = await wait(
          (output) =>
            output.kind === "event" &&
            output.event.type === "turn.completed" &&
            output.event.turnId === turnId,
        );
        if (completed.kind !== "event" || completed.event.type !== "turn.completed")
          throw new Error("No completion");
        if (action === "accept") {
          expect(completed.event.outcome.status).toBe("succeeded");
          expect((await readFile(file, "utf8")).trim()).toBe(token);
        } else {
          expect(await exists(file)).toBe(false);
        }
        if (action === "cancel") expect(completed.event.outcome.status).toBe("cancelled");
        const closedIndex = outputs.findIndex(
          (output) =>
            output.kind === "event" &&
            output.event.type === "interaction.closed" &&
            output.event.interactionId === interaction.interactionId,
        );
        expect(closedIndex).toBeGreaterThanOrEqual(0);
        expect(closedIndex).toBeLessThan(outputs.indexOf(completed));
        expect(
          await session.execute({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response: { type: "approval", actionId: "allow-once" },
          }),
        ).toMatchObject({ ok: false });
      }
      expect(error).toBeUndefined();
      stage = "passed";
    } finally {
      await adapter.close();
      await consume;
      const directory = process.env.CODEXHOST_ANTIGRAVITY_APPROVAL_EVIDENCE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, `${Date.now()}-${stage}.json`),
          JSON.stringify({ stage, outputs, wire, error: String(error ?? "") }, null, 2),
        );
      }
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 420_000);
});
