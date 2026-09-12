import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessAdapter, HostThreadSnapshot } from "@codexhost/harness-adapter";
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
  it("rejects a candidate if the Runtime record changes while native open is pending", async () => {
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
      nativeSessionId: "candidate-session",
      formatVersion: 1,
    });
    const candidate = new FakeHarnessSession(
      harnessId,
      adapter.catalog,
      undefined,
      candidateRef,
      snapshot(candidateRef.nativeSessionId, 2),
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
        runtime.register({ record, session, sessionId: id, thread: { id }, turns: [] });
      }
      const resolved = await runtime.resolve("target");
      if (resolved.kind !== "external") throw new Error("Fixture target did not resolve");
      const target = resolved.thread;
      const open = vi.spyOn(adapter, "open").mockImplementation(async () => {
        // Models a concurrent Host metadata/configuration path replacing the loaded record.
        target.record = await store.setTitle(target.id, "Updated while deriving");
        return { ok: true, value: candidate };
      });
      const result = await executeExternalThreadRollback({
        derived: target,
        rollback: { threadId: target.id, numTurns: 1 },
        adapters,
        repository,
        runtime,
      });

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: kind === "last-Turn" ? "rollbackLastTurn" : "fork" }),
      );
      expect(result).toMatchObject({ ok: false, error: { code: -32081 } });
      await expect(store.getThread(target.id)).resolves.toMatchObject({
        title: "Updated while deriving",
        nativeSessionRef: { nativeSessionId: "target-session" },
        turnMappings: expect.arrayContaining([
          expect.objectContaining({ hostTurnId: "target-turn-2" }),
        ]),
      });
      await expect(target.session.readSnapshot()).resolves.toMatchObject({ ok: true });
      await expect(candidate.readSnapshot()).resolves.toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await candidate.close();
      await Promise.all(runtime.values().map((thread) => thread.session.close()));
      runtime.clear();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
