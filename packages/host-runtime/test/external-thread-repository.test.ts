import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import { MappingStore, type StoredTurnMappingV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ExternalThreadRepository } from "../src/external-thread-repository.js";

const temporaryDirectories: string[] = [];
const harnessId = harnessIdSchema.parse("claude-code");
const hostThreadId = hostThreadIdSchema.parse("thread-1");
const nativeSessionRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "native-session-1",
  formatVersion: 1,
});

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-repository-"));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshotTurnForSession(
  sessionRef: typeof nativeSessionRef,
  key: string,
): HostThreadSnapshot["turns"][number] {
  return {
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId,
      nativeSessionId: sessionRef.nativeSessionId,
      nativeTurnKey: key,
      formatVersion: 1,
    }),
    input: [{ type: "text", text: `prompt ${key}` }],
    items: [],
    outcome: { status: "unknown", reason: "synthetic history" },
  };
}

function snapshotTurn(key: string): HostThreadSnapshot["turns"][number] {
  return snapshotTurnForSession(nativeSessionRef, key);
}

function mapping(hostKey: string, nativeKey: string): StoredTurnMappingV1 {
  return {
    hostTurnId: hostTurnIdSchema.parse(hostKey),
    nativeTurnRef: snapshotTurn(nativeKey).nativeTurnRef,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ExternalThreadRepository", () => {
  it("reuses legacy child identities and deduplicates overlapping native child materialization", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    const input = {
      harnessId,
      cwd: "/synthetic",
      title: "Parent",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "paginated" as const,
    };
    await store.createProvisional({ ...input, hostThreadId, createRequestId: "parent" });
    const parent = await store.commitReady({ hostThreadId, nativeSessionRef });
    try {
      const legacyId = hostThreadIdSchema.parse("legacy-child");
      await store.createProvisional({
        ...input,
        hostThreadId: legacyId,
        createRequestId: "old-random-create",
        subagent: { parentHostThreadId: hostThreadId, nativeSubagentId: "native-legacy" },
      });
      await store.commitReady({ hostThreadId: legacyId, nativeSessionRef });
      const child = {
        subagentId: "call-id",
        nativeSubagentId: "native-legacy",
        description: "Child",
        background: false,
        status: "running" as const,
      };
      expect((await repository.materializeSubagent(parent, child))?.hostThreadId).toBe(legacyId);
      const concurrent = await Promise.all(
        Array.from({ length: 4 }, () =>
          repository.materializeSubagent(parent, { ...child, nativeSubagentId: "native-new" }),
        ),
      );
      expect(new Set(concurrent.map((record) => record?.hostThreadId)).size).toBe(1);
      expect((await repository.list()).filter((record) => record.subagent)).toHaveLength(2);
      const stored = concurrent[0];
      if (!stored) throw new Error("Missing child");
      expect(await repository.sessionTreeId(stored)).toBe(hostThreadId);
      expect(
        await repository.materializeSubagent(parent, {
          subagentId: child.subagentId,
          description: child.description,
          background: child.background,
          status: child.status,
        }),
      ).toBeNull();
    } finally {
      await repository.close();
    }
  });

  it("rehydrates native Subagent history with stable Host children and sender identity", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-parent",
      harnessId,
      cwd: "/synthetic",
      title: "Parent",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    const parent = await store.commitReady({ hostThreadId, nativeSessionRef });
    const turn = snapshotTurn("spawn-turn");
    turn.items = [
      {
        item: {
          type: "subagentDelegation",
          itemId: hostItemIdSchema.parse("spawn-item"),
          operation: "spawn",
          prompt: "Explore the fixture",
          subagents: [
            {
              subagentId: "native-child",
              nativeSubagentId: "native-child",
              description: "Explorer",
              role: "explorer",
              background: false,
              status: "completed",
            },
          ],
        },
        outcome: { status: "succeeded" },
      },
    ];
    const snapshot = { turns: [turn] };
    const first = await repository.alignSnapshot(parent, snapshot);
    const child = (await repository.list()).find((entry) => entry.subagent);
    expect(child).toMatchObject({
      state: "ready",
      subagent: {
        parentHostThreadId: hostThreadId,
        nativeSubagentId: "native-child",
        role: "explorer",
      },
    });
    expect(first.turns[0]?.items).toContainEqual(
      expect.objectContaining({
        type: "collabAgentToolCall",
        senderThreadId: hostThreadId,
        receiverThreadIds: [child?.hostThreadId],
      }),
    );
    await repository.close();
    const reopened = new ExternalThreadRepository(new MappingStore({ directory }));
    await reopened.initialize();
    try {
      const restored = await reopened.find(hostThreadId);
      if (!restored) throw new Error("Missing parent");
      const again = await reopened.alignSnapshot(restored, snapshot);
      expect(again.turns).toEqual(first.turns);
      expect((await reopened.list()).filter((entry) => entry.subagent)).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  it("commits a last-Turn replacement with retained Host Turn identity", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-rollback",
      harnessId,
      cwd: "/synthetic",
      title: "Claude Thread",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: [mapping("host-a", "native-a"), mapping("host-b", "native-b")],
    });
    const replacementRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-2",
      formatVersion: 1,
    });

    const committed = await repository.commitLastTurnRollback(original, replacementRef, {
      turns: [snapshotTurnForSession(replacementRef, "native-a-derived")],
    });
    expect(committed.record).toMatchObject({
      nativeSessionRef: replacementRef,
      turnMappings: [
        {
          hostTurnId: original.turnMappings[0]?.hostTurnId,
          nativeTurnRef: { nativeSessionId: replacementRef.nativeSessionId },
        },
      ],
    });
    expect(committed.turns).toMatchObject([{ id: original.turnMappings[0]?.hostTurnId }]);
    await repository.close();
  });

  it("commits a last-Turn replacement that keeps the same Native Session identity", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-rewind",
      harnessId,
      cwd: "/synthetic",
      title: "Grok Thread",
      transportModelId: "codexhost/grok-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: [mapping("host-a", "native-a"), mapping("host-b", "native-b")],
    });

    const committed = await repository.commitLastTurnRollback(original, nativeSessionRef, {
      turns: [snapshotTurnForSession(nativeSessionRef, "native-a")],
    });
    expect(committed.record).toMatchObject({
      nativeSessionRef,
      turnMappings: [
        {
          hostTurnId: original.turnMappings[0]?.hostTurnId,
          nativeTurnRef: { nativeSessionId: nativeSessionRef.nativeSessionId },
        },
      ],
    });
    expect(committed.turns).toMatchObject([{ id: original.turnMappings[0]?.hostTurnId }]);
    await repository.close();
  });

  it("converges across consecutive cold alignments with middle-inserted Native Turns", async () => {
    const directory = await temporaryStoreDirectory();
    const firstStore = new MappingStore({ directory, instanceId: "first" });
    const firstRepository = new ExternalThreadRepository(firstStore);
    await firstRepository.initialize();
    await firstStore.createProvisional({
      hostThreadId,
      createRequestId: "create-1",
      harnessId,
      cwd: "/synthetic",
      title: "Claude Thread",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const originalMappings = [mapping("host-a", "native-a"), mapping("host-d", "native-d")];
    const original = await firstStore.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: originalMappings,
    });
    const snapshot: HostThreadSnapshot = {
      turns: ["native-a", "native-b", "native-c", "native-d"].map(snapshotTurn),
    };

    const first = await firstRepository.alignSnapshot(original, snapshot);
    expect(
      first.record.turnMappings.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey),
    ).toEqual(["native-a", "native-b", "native-c", "native-d"]);
    expect(first.record.turnMappings[0]?.hostTurnId).toBe(originalMappings[0]?.hostTurnId);
    expect(first.record.turnMappings[3]?.hostTurnId).toBe(originalMappings[1]?.hostTurnId);
    await firstRepository.close();

    const secondStore = new MappingStore({ directory, instanceId: "second" });
    const secondRepository = new ExternalThreadRepository(secondStore);
    await secondRepository.initialize();
    const restored = await secondRepository.find(hostThreadId);
    if (!restored) throw new Error("Reconciled Thread was not restored");

    const repeated = await secondRepository.alignSnapshot(restored, snapshot);
    expect(repeated.record).toEqual(restored);
    expect(repeated.record.turnMappings).toEqual(first.record.turnMappings);
    expect(repeated.turns.map((turn) => turn.id)).toEqual(
      first.record.turnMappings.map(({ hostTurnId }) => hostTurnId),
    );
    await secondRepository.close();
  });

  it("adopts Native Snapshot order when persisted mappings conflict", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-conflict",
      harnessId,
      cwd: "/synthetic",
      title: "Claude Thread",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const persisted = [mapping("host-a", "native-a"), mapping("host-missing", "native-missing")];
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: persisted,
    });
    const snapshot: HostThreadSnapshot = {
      turns: ["native-a", "native-extra"].map(snapshotTurn),
    };

    const aligned = await repository.alignSnapshot(original, snapshot);
    expect(
      aligned.record.turnMappings.map(({ nativeTurnRef }) => nativeTurnRef.nativeTurnKey),
    ).toEqual(["native-a", "native-extra"]);
    expect(aligned.record.turnMappings[0]?.hostTurnId).toBe(persisted[0]?.hostTurnId);
    expect(aligned.record.turnMappings[1]?.hostTurnId).not.toBe(persisted[1]?.hostTurnId);
    expect(aligned.turns.map((turn) => turn.id)).toEqual(
      aligned.record.turnMappings.map(({ hostTurnId }) => hostTurnId),
    );
    await repository.close();
  });
});
