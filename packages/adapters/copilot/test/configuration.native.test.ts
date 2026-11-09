import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostTurnIdSchema, harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CopilotAdapter } from "../src/adapter.js";
import { createCopilotClient } from "../src/client.js";
import { modelRef } from "../src/configuration.js";

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "Copilot native model eligibility",
  () => {
    it("offers Auto without a concrete model list, rejects unavailable settings, and keeps native configuration across resume", async () => {
      const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "copilot-model-native-")));
      const adapter = new CopilotAdapter({ ...process.env });
      const inspector = createCopilotClient({ cwd, environment: process.env });
      let nativeId: string | undefined;
      try {
        await inspector.start();
        const ids = async () =>
          (await inspector.listSessions())
            .filter((entry) => entry.context?.workingDirectory === cwd)
            .map(({ sessionId }) => sessionId)
            .sort();
        const before = await ids();
        const inspection = await adapter.inspect({ cwd, refresh: true });
        if (inspection.status !== "ready") throw new Error("Native inspection unavailable");
        expect(inspection.catalog.models.some(({ ref }) => ref.id === modelRef("auto").id)).toBe(
          true,
        );
        expect(inspection.catalog.defaultModel).toEqual(modelRef("auto"));
        expect(await ids()).toEqual(before);
        for (const configuration of [
          { model: modelRef("codexhost-nonexistent-model") },
          {
            model: modelRef("auto"),
            thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
          },
        ]) {
          const rejected = await adapter.open({ kind: "create", cwd, ...configuration });
          if (!rejected.ok) throw new Error(rejected.error.message);
          expect(
            await rejected.value.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("must-not-start"),
              input: [{ type: "text", text: "This request must be rejected before sending." }],
            }),
          ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
          await rejected.value.close();
          const id = rejected.value.nativeWriterRef?.nativeSessionId;
          if (!id) throw new Error("Missing reserved draft ID");
          expect(
            await access(
              path.join(
                process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot"),
                "session-state",
                id,
              ),
            ).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }
        const initialModel = inspection.catalog.defaultModel;
        if (!initialModel) throw new Error("Copilot omitted its initial Model choice");
        const opened = await adapter.open({ kind: "create", cwd, model: initialModel });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        nativeId = session.nativeWriterRef?.nativeSessionId;
        const outputs: HarnessOutput[] = [];
        const consuming = (async () => {
          for await (const output of session.outputs) outputs.push(output);
        })();
        expect(
          await session.execute({
            type: "model.select",
            model: modelRef("codexhost-nonexistent-model"),
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
        expect(
          await session.execute({
            type: "thinking.select",
            thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
        const snapshotBefore = await session.readSnapshot();
        expect(snapshotBefore.ok && snapshotBefore.value.state?.effectiveModel).toEqual(
          modelRef("auto"),
        );
        expect(snapshotBefore.ok && snapshotBefore.value.state?.availableThinkingOptions).toEqual(
          [],
        );
        expect(outputs.some((o) => o.kind === "event" && o.event.type === "turn.started")).toBe(
          false,
        );
        for (const key of ["auto-one", "auto-two"]) {
          const turnId = hostTurnIdSchema.parse(key);
          expect(
            (
              await session.execute({
                type: "turn.start",
                turnId,
                input: [
                  { type: "text", text: `Reply exactly ${key.toUpperCase()}. Do not use tools.` },
                ],
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
                    o.event.turnId === turnId &&
                    o.event.outcome.status === "succeeded",
                ),
              ).toBe(true),
            { timeout: 60000, interval: 100 },
          );
          const snapshot = await session.readSnapshot();
          expect(snapshot.ok && snapshot.value.state?.effectiveModel).toEqual(modelRef("auto"));
          expect(snapshot.ok && snapshot.value.state?.effectiveThinkingOptionId).toBeUndefined();
        }
        const completedSnapshot = await session.readSnapshot();
        const ref = completedSnapshot.ok ? completedSnapshot.value.state?.nativeRef : undefined;
        if (!ref) throw new Error("Missing durable native identity");
        nativeId = ref.nativeSessionId;
        await session.close();
        await consuming;
        const resumed = await adapter.open({ kind: "resume", nativeRef: ref, cwd });
        if (!resumed.ok) throw new Error(resumed.error.message);
        const snapshot = await resumed.value.readSnapshot();
        expect(snapshot.ok && snapshot.value.turns).toHaveLength(2);
        expect(snapshot.ok && snapshot.value.state?.effectiveModel).toEqual(modelRef("auto"));
        expect(snapshot.ok && snapshot.value.state?.effectiveThinkingOptionId).toBeUndefined();
        await resumed.value.close();
      } finally {
        await adapter.close();
        if (nativeId) await inspector.deleteSession(nativeId);
        await inspector.stop();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 180000);
  },
);
