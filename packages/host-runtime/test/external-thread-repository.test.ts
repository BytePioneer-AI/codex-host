import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import { MappingStore, type StoredTurnMappingV1 } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
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

function malformedSnapshotTurnForSession(
  sessionRef: typeof nativeSessionRef,
  key: string,
): HostThreadSnapshot["turns"][number] {
  return {
    ...snapshotTurnForSession(sessionRef, key),
    items: [
      {
        item: {
          type: "subagentDelegation",
          itemId: "malformed-item",
          operation: "spawn",
          subagents: null,
        },
        outcome: { status: "succeeded" },
      },
    ],
  } as unknown as HostThreadSnapshot["turns"][number];
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

  it("rejects a stale Fork rollback after the derived record changes", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    const sourceThreadId = hostThreadIdSchema.parse("source-thread");
    const sourceSessionRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const sourceMappings = [1, 2, 3].map((ordinal): StoredTurnMappingV1 => ({
      hostTurnId: hostTurnIdSchema.parse(`source-host-${ordinal}`),
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId,
        nativeSessionId: sourceSessionRef.nativeSessionId,
        nativeTurnKey: `source-native-${ordinal}`,
        formatVersion: 1,
      }),
      nativeCheckpointRef: nativeCheckpointRefSchema.parse({
        harnessId,
        nativeSessionId: sourceSessionRef.nativeSessionId,
        checkpointId: `source-checkpoint-${ordinal}`,
        formatVersion: 1,
      }),
    }));
    const forkBoundary = sourceMappings[2];
    if (!forkBoundary) throw new Error("Synthetic source Fork boundary is missing");
    await store.createProvisional({
      hostThreadId: sourceThreadId,
      createRequestId: "create-source",
      harnessId,
      cwd: "/synthetic",
      title: "Source Thread",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    const source = await store.commitReady({
      hostThreadId: sourceThreadId,
      nativeSessionRef: sourceSessionRef,
      turnMappings: sourceMappings,
    });
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-derived",
      harnessId,
      cwd: "/synthetic",
      title: "Derived Thread",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "legacy",
      forkSource: {
        hostThreadId: sourceThreadId,
        hostTurnId: forkBoundary.hostTurnId,
      },
    });
    const derived = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: [
        mapping("derived-host-1", "derived-native-1"),
        mapping("derived-host-2", "derived-native-2"),
        mapping("derived-host-3", "derived-native-3"),
      ],
    });
    const newer = await store.setTitle(hostThreadId, "Newer derived title");
    const replacementRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "replacement-session",
      formatVersion: 1,
    });

    await expect(
      repository.commitForkRollback(derived, source, replacementRef, {
        turns: [
          snapshotTurnForSession(replacementRef, "replacement-native-1"),
          snapshotTurnForSession(replacementRef, "replacement-native-2"),
        ],
      }),
    ).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
    await expect(store.getThread(hostThreadId)).resolves.toEqual(newer);
    await repository.close();
  });

  it("rejects a last-Turn replacement that keeps the same Native Session identity", async () => {
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

    await expect(
      repository.commitLastTurnRollback(original, nativeSessionRef, {
        turns: [snapshotTurnForSession(nativeSessionRef, "native-a")],
      }),
    ).rejects.toThrow("not an exact ready Session replacement");
    await expect(store.getThread(hostThreadId)).resolves.toEqual(original);
    await repository.close();
  });

  it("validates rollback projection before replacing the stored Session", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-malformed-rollback",
      harnessId,
      cwd: "/synthetic",
      title: "Malformed rollback",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "paginated",
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

    await expect(
      repository.commitLastTurnRollback(original, replacementRef, {
        turns: [malformedSnapshotTurnForSession(replacementRef, "native-a-derived")],
      }),
    ).rejects.toThrow();
    await expect(store.getThread(hostThreadId)).resolves.toEqual(original);
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

  it("projects only already-mapped live history without inventing Host Turn IDs", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-live-projection",
      harnessId,
      cwd: "/synthetic",
      title: "Live projection",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: [mapping("host-a", "native-a")],
    });

    expect(
      repository.projectKnownSnapshot(original, { turns: [snapshotTurn("native-a")] }),
    ).toMatchObject({
      record: original,
      turns: [{ id: "host-a" }],
    });
    expect(
      repository.projectKnownSnapshot(original, {
        turns: [snapshotTurn("native-a"), snapshotTurn("native-b")],
      }),
    ).toBeNull();
    expect(
      repository.projectKnownSnapshot(original, { turns: [snapshotTurn("native-b")] }),
    ).toBeNull();
    await expect(store.getThread(hostThreadId)).resolves.toEqual(original);
    await repository.close();
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

  it("validates refreshed history projection before reconciling stored mappings", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    const repository = new ExternalThreadRepository(store);
    await repository.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-malformed-refresh",
      harnessId,
      cwd: "/synthetic",
      title: "Malformed refresh",
      transportModelId: "codexhost/claude-code-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef,
      turnMappings: [mapping("host-a", "native-a")],
    });

    await expect(
      repository.alignSnapshot(original, {
        turns: [
          snapshotTurn("native-a"),
          malformedSnapshotTurnForSession(nativeSessionRef, "native-b"),
        ],
      }),
    ).rejects.toThrow();
    await expect(store.getThread(hostThreadId)).resolves.toEqual(original);
    await repository.close();
  });
});
