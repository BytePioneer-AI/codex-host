import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import {
  hostTurnIdSchema,
  harnessIdSchema,
  harnessPermissionModeIdSchema,
} from "@codexhost/shared-contracts";

import { loadHarnessPlugins, type HarnessPluginDiagnostic } from "../src/harness-plugin-loader.js";
import { CodexTurnProjector } from "@codexhost/protocol-core";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";

/**
 * Real regression test for the swallowed-terminal-event deadlock:
 * a Hermes Turn that ends while an approval Interaction is still pending
 * must still produce a projected turn/completed. Before the fix the
 * projector threw ("pending Interactions"), the host never broadcast the
 * terminal event, and the renderer spun forever ("No active Turn" on every
 * steer/interrupt).
 *
 * Uses the real packaged plugin and a real `hermes acp` child process, but
 * keeps the projection layer under test synchronously (that is where the
 * deadlock lived).
 */
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginSource = path.join(repoRoot, "packages/host-runtime/dist/plugins/hermes");

let root: string | undefined;
const diagnostics: HarnessPluginDiagnostic[] = [];

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.env.CODEXHOST_RUN_HERMES_LIVE !== "1")(
  "Hermes harness plugin (approval abandoned at Turn end)",
  () => {
    it(
      "still completes the Turn when an approval is abandoned mid-Turn",
      { timeout: 180_000 },
      async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "hermes-approval-abandon-"));
        await writeFile(
          path.join(root, "enabled.json"),
          JSON.stringify({ version: 1, enabled: ["hermes"] }),
        );
        await cp(pluginSource, path.join(root, "hermes"), { recursive: true });

        const registry = await loadHarnessPlugins({
          roots: [root],
          context: {
            environment: process.env,
            platform: process.platform,
            managedRemoteHost: false,
          },
          diagnose: (diagnostic) => diagnostics.push(diagnostic),
        });
        const adapter = registry.adapters.get(harnessIdSchema.parse("hermes"));
        if (!adapter) throw new Error("Hermes adapter not found");

        const created = await adapter.open({
          kind: "create",
          cwd: repoRoot,
          executionPolicy: "default",
          // "default" = ask on every edit approval; the test never answers,
          // which is exactly the deadlock scenario.
          permissionModeId: harnessPermissionModeIdSchema.parse("default"),
        });
        if (!created.ok) throw new Error(`create failed: ${created.error.message}`);
        const session: HarnessSession = created.value;

        const turnId = hostTurnIdSchema.parse("approval-abandon-turn-1");
        const outputs: HarnessOutput[] = [];
        void collectOutputs(session.outputs, outputs);

        // Ask for a write in the repo workspace: default permission mode asks
        // the client to approve, which we never answer.
        const started = await session.execute({
          type: "turn.start",
          turnId,
          input: [
            {
              type: "text",
              text: "Call the write_file tool exactly once to create file hermes-e2e-approval-abandon.txt in the current directory containing the single line APPROVAL_ABANDON_TEST. Rules: do not call any other tool, do not explain, reply with just the word DONE after the tool call. Keep the response under 10 words total.",
            },
          ],
        });
        expect(started.ok).toBe(true);

        // Wait until an approval interaction appears (or the turn ends).
        const deadline = Date.now() + 120_000;
        let approvalInteractionId: string | undefined;
        let terminal: undefined | { status: string };
        while (Date.now() < deadline) {
          for (const output of outputs) {
            if (output.kind === "interaction" && !approvalInteractionId) {
              approvalInteractionId = String(output.interaction.interactionId);
            }
            if (output.kind === "event" && output.event.type === "turn.completed") {
              terminal = { status: output.event.outcome.status };
            }
          }
          if (terminal) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (!approvalInteractionId) {
          // The turn may finish without asking (model refused / no approval
          // needed). The invariant still holds: terminal must exist.
          expect(terminal).toBeDefined();
        } else {
          // The turn may already have ended on its own (approval auto-denied
          // after Hermes' 60s timeout, or the model gave up). Either way the
          // invariant under test is the same: the plugin MUST have emitted
          // turn.completed even though the approval Interaction never got a
          // response. Try to cancel first; ignore "no active Turn" — that in
          // itself proves the turn already terminated.
          const cancelled = await session.execute({ type: "turn.cancel", turnId });
          expect(cancelled.ok || cancelled.error.code === "invalidRequest").toBe(true);
          const cancelDeadline = Date.now() + 90_000;
          while (!terminal && Date.now() < cancelDeadline) {
            for (const output of outputs) {
              if (output.kind === "event" && output.event.type === "turn.completed") {
                terminal = { status: output.event.outcome.status };
              }
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          expect(terminal).toBeDefined();
        }

        // THE INVARIANT: replay the collected events through the projector.
        // Before the fix this threw "Host Turn completed with pending
        // Interactions" when the approval was still open at cancellation.
        const projector = new CodexTurnProjector({
          threadId: "thread-e2e-approval-abandon",
          turnId,
          cwd: repoRoot,
          startedAtMs: Date.now(),
        });
        const messages: { method: string }[] = [];
        for (const output of outputs) {
          if (output.kind !== "event") continue;
          const event = output.event;
          if (event.type === "turn.started" || event.type === "turn.completed") {
            if (event.type === "turn.completed") {
              const result = projector.project(event);
              expect(result.completedTurn).toMatchObject({ id: turnId });
              for (const message of result.messages) {
                messages.push(message as unknown as { method: string });
              }
            } else {
              projector.project(event);
            }
          }
        }
        expect(messages.some((message) => message.method === "turn/completed")).toBe(true);

        await session.close().catch(() => undefined);
        await registry.close();
      },
    );
  },
);

async function collectOutputs(
  source: AsyncIterable<HarnessOutput>,
  sink: HarnessOutput[],
): Promise<void> {
  try {
    for await (const output of source) sink.push(output);
  } catch {
    // Session closed; collection ends.
  }
}
