import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CopilotClient, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CopilotAdapter } from "../src/adapter.js";
import { createCopilotClient } from "../src/client.js";

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "Copilot native account and AI Credits",
  () => {
    it("reads authoritative quota without a model Turn, removes its draft, and reports session AI Credits", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-credits-native-"));
      const nativeRoot = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
      const created: CopilotSession[] = [];
      const create = CopilotClient.prototype.createSession;
      const spy = vi
        .spyOn(CopilotClient.prototype, "createSession")
        .mockImplementation(async function (this: CopilotClient, config: SessionConfig) {
          const session = await create.call(this, config);
          created.push(session);
          return session;
        });
      const adapter = new CopilotAdapter({ ...process.env });
      const cleanup = createCopilotClient({ cwd, environment: process.env });
      try {
        const account = await adapter.inspectAccount();
        expect(account?.credits?.unit).toBe("AI Credits");
        expect(account?.credits?.usedPercent).toBeGreaterThanOrEqual(0);
        expect(account?.credits?.limit).toBeGreaterThan(0);
        expect(adapter.credits()).toEqual(account?.credits);
        expect(created).toHaveLength(1);
        const draftId = created[0]?.sessionId;
        if (!draftId) throw new Error("Missing quota draft identity");
        expect(
          await access(path.join(nativeRoot, "session-state", draftId)).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const outputs: HarnessOutput[] = [];
        const reading = (async () => {
          for await (const output of opened.value.outputs) outputs.push(output);
        })();
        expect(
          (
            await opened.value.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("credits"),
              input: [{ type: "text", text: "Reply exactly CREDITS_OK. Do not use tools." }],
            })
          ).ok,
        ).toBe(true);
        await vi.waitFor(
          () =>
            expect(
              outputs.some(
                (o) =>
                  o.kind === "event" &&
                  o.event.type === "turn.completed" &&
                  o.event.outcome.status === "succeeded",
              ),
            ).toBe(true),
          { timeout: 60_000, interval: 100 },
        );
        await opened.value.refreshUsage?.();
        const native = created[1];
        if (!native) throw new Error("Missing chat native session");
        const metrics = await native.rpc.usage.getMetrics();
        expect(metrics.totalNanoAiu).toBeGreaterThan(0);
        const usage = outputs
          .flatMap((o) =>
            o.kind === "event" && o.event.type === "session.usage.changed" ? [o.event.usage] : [],
          )
          .at(-1);
        expect(usage?.totalCredits).toBe((metrics.totalNanoAiu ?? 0) / 1e9);
        expect(usage?.totalCostUsd).toBeUndefined();
        await opened.value.close();
        await reading;
      } finally {
        spy.mockRestore();
        await adapter.close();
        await cleanup.start();
        try {
          for (const session of created) {
            if (
              await access(path.join(nativeRoot, "session-state", session.sessionId)).then(
                () => true,
                () => false,
              )
            )
              await cleanup.deleteSession(session.sessionId);
          }
        } finally {
          await cleanup.stop();
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }, 120_000);
  },
);
