import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession, TurnCompletedEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
import { CopilotAdapter } from "../src/adapter.js";
import { modelRef } from "../src/configuration.js";
import { createCopilotClient } from "../src/client.js";

function observe(session: HarnessSession) {
  const outputs: HarnessOutput[] = [];
  const reading = (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  const terminals = () =>
    outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "turn.completed" ? [output.event] : [],
    );
  return {
    outputs,
    async send(text: string, id: string): Promise<TurnCompletedEvent> {
      const turnId = hostTurnIdSchema.parse(id);
      const accepted = await session.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text }],
      });
      expect(accepted.ok).toBe(true);
      await vi.waitFor(
        () => expect(terminals().find((event) => event.turnId === turnId)).toBeDefined(),
        { timeout: 60_000, interval: 50 },
      );
      const terminal = terminals().find((event) => event.turnId === turnId);
      if (!terminal) throw new Error("Missing native terminal");
      return terminal;
    },
    async close() {
      await session.close();
      await reading;
    },
  };
}

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "Copilot native Adapter history and draft cleanup",
  () => {
    it("preserves a failed native tool while the same logical Turn recovers", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-tool-failure-native-"));
      const adapter = new CopilotAdapter({ ...process.env });
      try {
        const opened = await adapter.open({
          kind: "create",
          cwd,
          executionPolicy: "unattended-full-access",
        });
        if (!opened.ok) throw new Error(opened.error.message);
        const output = observe(opened.value);
        expect(
          (
            await output.send(
              "Run the bash command false once. The failure is intentional; after observing it, reply exactly RECOVERED. Do not retry or use other tools.",
              "tool-failure",
            )
          ).outcome.status,
        ).toBe("succeeded");
        const snapshot = await opened.value.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        expect(
          snapshot.value.turns[0]?.items.some(
            ({ item, outcome }) => item.type === "commandExecution" && outcome.status === "failed",
          ),
        ).toBe(true);
        expect(
          snapshot.value.turns[0]?.items.some(
            ({ item }) => item.type === "agentMessage" && item.text.includes("RECOVERED"),
          ),
        ).toBe(true);
        await output.close();
      } finally {
        await adapter.close();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 90_000);
    it("confirms/discards drafts and derives exact independent prefixes, including empty rollback", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-adapter-native-"));
      const adapter = new CopilotAdapter({ ...process.env });
      try {
        const draft = await adapter.open({ kind: "create", cwd });
        if (!draft.ok) throw new Error(draft.error.message);
        const nativeId = draft.value.nativeWriterRef?.nativeSessionId;
        if (!nativeId) throw new Error("Missing reserved identity");
        expect(
          (await draft.value.execute({ type: "model.select", model: modelRef("auto") })).ok,
        ).toBe(true);
        await draft.value.close();
        const nativeRoot = process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
        expect(
          await access(path.join(nativeRoot, "session-state", nativeId)).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        const opened = await adapter.open({
          kind: "create",
          cwd,
          model: modelRef("auto"),
        });
        if (!opened.ok) throw new Error(opened.error.message);
        const source = opened.value;
        const output = observe(source);
        const first = await output.send(
          "Reply exactly NATIVE_PREFIX. Do not use tools.",
          "native-prefix",
        );
        expect(first.outcome.status).toBe("succeeded");
        const checkpoint = first.outcome.checkpoint;
        if (!checkpoint) throw new Error("Missing checkpoint");
        await output.send("Reply exactly NATIVE_TAIL. Do not use tools.", "native-tail");
        const before = await source.readSnapshot();
        if (!before.ok || !before.value.state?.nativeRef)
          throw new Error("Missing source snapshot");
        const ref = before.value.state.nativeRef;
        expect(
          output.outputs.some(
            (value) =>
              value.kind === "event" &&
              value.event.type === "session.state.changed" &&
              value.event.state.effectiveModel?.id === modelRef("auto").id,
          ),
        ).toBe(true);
        expect(before.value.state.effectiveModel).toEqual(modelRef("auto"));
        expect(before.value.state.effectiveThinkingOptionId).toBeUndefined();
        await vi.waitFor(() => expect(source.hasBackgroundWork?.()).toBe(false));
        const forked = await adapter.open({ kind: "fork", sourceRef: ref, checkpoint, cwd });
        if (!forked.ok) throw new Error(forked.error.message);
        const forkSnapshot = await forked.value.readSnapshot();
        if (!forkSnapshot.ok) throw new Error(forkSnapshot.error.message);
        expect(forkSnapshot.value.turns).toHaveLength(1);
        expect(forkSnapshot.value.state?.effectiveThinkingOptionId).toBe(
          before.value.state.effectiveThinkingOptionId,
        );
        expect(forkSnapshot.value.turns[0]?.input).toEqual(before.value.turns[0]?.input);
        const forkOutput = observe(forked.value);
        await forkOutput.send("Reply exactly FORK_ONLY. Do not use tools.", "fork-only");
        const unchanged = await source.readSnapshot();
        expect(unchanged).toEqual(before);
        await forkOutput.close();
        const inspector = createCopilotClient({ cwd, environment: process.env });
        try {
          await inspector.start();
          const ownIds = async () =>
            (await inspector.listSessions())
              .filter((session) => session.context?.workingDirectory === cwd)
              .map((session) => session.sessionId)
              .sort();
          const preceding = await ownIds();
          // This verified CLI/account rejects assisted mode; the rejected copy must be removed.
          const failed = await adapter.open({
            kind: "rollbackLastTurn",
            sourceRef: ref,
            cwd,
            permissionModeId: harnessPermissionModeIdSchema.parse("assisted"),
          });
          expect(failed.ok).toBe(false);
          expect(await ownIds()).toEqual(preceding);
          expect(await source.readSnapshot()).toEqual(before);
        } finally {
          await inspector.stop();
        }
        const rolled = await adapter.open({
          kind: "rollbackLastTurn",
          sourceRef: ref,
          cwd,
          ...(before.value.state.effectiveModel
            ? { model: before.value.state.effectiveModel }
            : {}),
          ...(before.value.state.effectivePermissionModeId
            ? { permissionModeId: before.value.state.effectivePermissionModeId }
            : {}),
        });
        if (!rolled.ok) throw new Error(rolled.error.message);
        const rolledSnapshot = await rolled.value.readSnapshot();
        if (!rolledSnapshot.ok || !rolledSnapshot.value.state?.nativeRef)
          throw new Error("Missing rollback snapshot");
        expect(rolledSnapshot.value.turns).toHaveLength(1);
        expect(rolledSnapshot.value.state.effectiveThinkingOptionId).toBe(
          before.value.state.effectiveThinkingOptionId,
        );
        const empty = await adapter.open({
          kind: "rollbackLastTurn",
          sourceRef: rolledSnapshot.value.state.nativeRef,
          cwd,
          ...(rolledSnapshot.value.state.effectiveModel
            ? { model: rolledSnapshot.value.state.effectiveModel }
            : {}),
        });
        if (!empty.ok) throw new Error(empty.error.message);
        const emptySnapshot = await empty.value.readSnapshot();
        expect(emptySnapshot.ok && emptySnapshot.value.turns.length).toBe(0);
        expect(emptySnapshot.ok && emptySnapshot.value.state?.effectiveThinkingOptionId).toBe(
          before.value.state.effectiveThinkingOptionId,
        );
        const emptyOutput = observe(empty.value);
        expect(
          (
            await emptyOutput.send(
              "Reply exactly EMPTY_CONTINUES. Do not use tools.",
              "empty-continues",
            )
          ).outcome.status,
        ).toBe("succeeded");
        await emptyOutput.close();
        await rolled.value.close();
        await output.close();
      } finally {
        await adapter.close();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
