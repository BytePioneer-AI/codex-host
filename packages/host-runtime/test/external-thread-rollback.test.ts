import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessSession,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { executeExternalThreadRollback } from "../src/external-thread-rollback.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

const harnessId = harnessIdSchema.parse("pi");

function snapshot(sessionId: string, count: number): HostThreadSnapshot {
  return {
    turns: Array.from({ length: count }, (_, index) => ({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        nativeTurnKey: `turn-${index}`,
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: sessionId,
        checkpointId: `checkpoint-${index}`,
        formatVersion: 1,
      }),
      input: [{ type: "text", text: `prompt ${index}` }],
      items: [],
      outcome: { status: "succeeded" },
    })),
  };
}

describe.each(["last-Turn", "Fork-derived"] as const)("%s rollback preparation", (kind) => {
  it.each([
    "stale record",
    "overlapping access",
    "owned candidate",
    "changed prefix",
    "throwing read",
    "failed close",
    "stalled drain",
    "failed publication",
    ...(kind === "last-Turn"
      ? ["same identity" as const, "fixed configuration" as const, "fixed mismatch" as const]
      : []),
  ] as const)("handles %s during native replacement", async (scenario) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-rollback-cas-"));
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    const adapter = new FakeHarnessAdapter(harnessId);
    const adapters = new Map<ExternalHarnessId, HarnessAdapter>([["pi", adapter]]);
    const runtime = new ExternalThreadRuntime({
      adapters,
      repository,
      consumeOutputs: async () => undefined,
      diagnose: () => undefined,
    });
    const candidateRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: scenario === "same identity" ? "target-session" : "candidate-session",
      formatVersion: 1,
    });
    let targetNative: HarnessSession | undefined;
    const outputDrain = Promise.withResolvers<undefined>();
    const candidateHistory = snapshot(candidateRef.nativeSessionId, 2);
    const firstTurn = candidateHistory.turns[0];
    if (scenario === "changed prefix" && firstTurn)
      firstTurn.input = [{ type: "text", text: "unexpected replacement" }];
    const candidate = new FakeHarnessSession(
      harnessId,
      adapter.catalog,
      undefined,
      candidateRef,
      candidateHistory,
    );

    try {
      await repository.initialize();
      const parentThreadId = hostThreadIdSchema.parse("parent");
      for (const id of [parentThreadId, hostThreadIdSchema.parse("target")]) {
        const nativeRef = nativeSessionRefSchema.parse({
          harnessId,
          nativeSessionId: `${id}-session`,
          formatVersion: 1,
        });
        const history = snapshot(nativeRef.nativeSessionId, 3);
        await store.createProvisional({
          hostThreadId: id,
          createRequestId: `create-${id}`,
          harnessId,
          cwd: "/synthetic",
          transportModelId: "codexhost/pi-native",
          ephemeral: false,
          historyMode: "paginated",
          ...(id === "target"
            ? {
                forkSource: {
                  hostThreadId: parentThreadId,
                  hostTurnId: hostTurnIdSchema.parse("parent-turn-2"),
                },
              }
            : {}),
        });
        const record = await store.commitReady({
          hostThreadId: id,
          nativeSessionRef: nativeRef,
          turnMappings: history.turns.map((turn, index) => ({
            hostTurnId: hostTurnIdSchema.parse(`${id}-turn-${index}`),
            nativeTurnRef: turn.nativeTurnRef,
            nativeCheckpointRef: turn.checkpoint,
          })),
        });
        const session = new FakeHarnessSession(
          harnessId,
          adapter.catalog,
          undefined,
          nativeRef,
          history,
          true,
          "/synthetic",
          true,
          undefined,
          null,
          undefined,
          undefined,
          kind === "last-Turn",
        );
        if (id === "target") targetNative = session;
        runtime.register({ record, session, sessionId: id, thread: { id }, turns: [] });
      }
      const resolved = await runtime.resolve("target");
      if (resolved.kind !== "external") throw new Error("Fixture target did not resolve");
      const target = resolved.thread;
      if (!targetNative) throw new Error("Fixture source is missing");
      if (scenario === "failed publication")
        vi.spyOn(runtime, "register").mockImplementationOnce(() => {
          throw new Error("publication failed");
        });
      if (scenario === "fixed configuration" || scenario === "fixed mismatch") {
        Object.defineProperty(candidate, "capabilities", {
          value: {
            ...candidate.capabilities,
            configuration: {
              ...candidate.capabilities.configuration,
              selectModel: false,
              selectThinkingOption: false,
            },
          },
        });
        if (scenario === "fixed mismatch") {
          const alternate = adapter.catalog.models.find(
            ({ ref }) => ref.id !== targetNative?.initialState.effectiveModel?.id,
          )?.ref;
          if (!alternate) throw new Error("Fixture alternate model is missing");
          candidate.setStateForSnapshot({ nativeRef: candidateRef, effectiveModel: alternate });
        }
      }
      if (scenario === "throwing read")
        vi.spyOn(candidate, "readSnapshot").mockRejectedValue(new Error("bad native read"));
      if (scenario === "failed close")
        vi.spyOn(targetNative, "close").mockRejectedValue(new Error("native writer remains"));
      const open = vi.spyOn(adapter, "open").mockImplementation(async () => {
        // Models a concurrent Host metadata/configuration path replacing the loaded record.
        if (scenario === "stale record")
          target.record = await store.setTitle(target.id, "Updated while deriving");
        if (scenario === "overlapping access") {
          await expect(
            target.session.execute({
              type: "turn.start",
              turnId: hostTurnIdSchema.parse("competing"),
              input: [{ type: "text", text: "must not send" }],
            }),
          ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
          await expect(
            executeExternalThreadRollback({
              derived: target,
              rollback: { threadId: target.id, numTurns: 1 },
              adapters,
              repository,
              runtime,
            }),
          ).resolves.toMatchObject({ ok: false, error: { code: -32072 } });
        }
        const parent = runtime.get("parent");
        if (scenario === "owned candidate" && parent) return { ok: true, value: parent.session };
        return { ok: true, value: candidate };
      });
      const closeObserved = scenario === "stalled drain" ? vi.spyOn(targetNative, "close") : null;
      if (scenario === "stalled drain") {
        target.outputTask = outputDrain.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const rollingBack = executeExternalThreadRollback({
        derived: target,
        rollback: { threadId: target.id, numTurns: 1 },
        adapters,
        repository,
        runtime,
      });
      if (scenario === "stalled drain") {
        await vi.waitFor(() => expect(closeObserved).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(10_000);
      }
      const result = await rollingBack;
      vi.useRealTimers();

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: kind === "last-Turn" ? "rollbackLastTurn" : "fork" }),
      );
      if (
        scenario === "overlapping access" ||
        scenario === "same identity" ||
        scenario === "fixed configuration"
      ) {
        expect(result).toMatchObject({ ok: true });
        await expect(store.getThread(target.id)).resolves.toMatchObject({
          nativeSessionRef: candidateRef,
          turnMappings: [{}, {}],
        });
      } else if (scenario === "failed publication") {
        expect(result).toMatchObject({ ok: false });
        await expect(store.getThread(target.id)).resolves.toMatchObject({
          nativeSessionRef: candidateRef,
          turnMappings: [{}, {}],
        });
        expect(runtime.get(target.id)).toBeUndefined();
        await expect(candidate.readSnapshot()).resolves.toMatchObject({ ok: false });
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code:
              scenario === "stale record"
                ? -32081
                : scenario === "changed prefix" || scenario === "fixed mismatch"
                  ? -32080
                  : -32076,
          },
        });
        await expect(store.getThread(target.id)).resolves.toMatchObject({
          ...(scenario === "stale record" ? { title: "Updated while deriving" } : {}),
          nativeSessionRef: { nativeSessionId: "target-session" },
          turnMappings: expect.arrayContaining([
            expect.objectContaining({ hostTurnId: "target-turn-2" }),
          ]),
        });
        if (scenario === "stalled drain") {
          expect(runtime.get(target.id)).toBe(target);
          await expect(target.session.readSnapshot()).resolves.toMatchObject({
            ok: false,
            error: { code: "invalidState" },
          });
          outputDrain.resolve(undefined);
          await target.outputTask;
          expect(runtime.get(target.id)).toBe(target);
        } else {
          await expect(targetNative.readSnapshot()).resolves.toMatchObject({ ok: true });
        }
        if (scenario === "owned candidate")
          await expect(runtime.get("parent")?.session.readSnapshot()).resolves.toMatchObject({
            ok: true,
          });
        if (scenario === "failed close")
          await expect(target.session.readSnapshot()).resolves.toMatchObject({
            ok: false,
            error: { code: "invalidState" },
          });
        if (scenario !== "owned candidate" && scenario !== "throwing read") {
          await expect(candidate.readSnapshot()).resolves.toMatchObject({
            ok: false,
            error: { code: "invalidState" },
          });
        }
      }
    } finally {
      vi.useRealTimers();
      outputDrain.resolve(undefined);
      vi.restoreAllMocks();
      await candidate.close();
      await Promise.all(runtime.values().map((thread) => thread.session.close()));
      runtime.clear();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
