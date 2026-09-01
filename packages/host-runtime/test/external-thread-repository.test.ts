import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostThreadSnapshot } from "@codexhost/harness-adapter";
import {
  MappingStore,
  type StoredThreadRecordV1,
  type StoredTurnMappingV1,
} from "@codexhost/mapping-store";
import {
  harnessIdSchema,
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
  it("resolves persisted and legacy Delegation policies, and defaults ordinary Threads safely", async () => {
    const delegated = hostThreadIdSchema.parse("thread-delegated");
    const legacy = hostThreadIdSchema.parse("thread-legacy");
    const ordinary = hostThreadIdSchema.parse("thread-ordinary");
    const derived = hostThreadIdSchema.parse("thread-derived");
    const orphan = hostThreadIdSchema.parse("thread-orphan");
    const records = new Map([
      [delegated, { hostThreadId: delegated }],
      [legacy, { hostThreadId: legacy }],
      [ordinary, { hostThreadId: ordinary }],
      [
        derived,
        {
          hostThreadId: derived,
          forkSource: {
            hostThreadId: delegated,
            hostTurnId: hostTurnIdSchema.parse("source-turn"),
          },
        },
      ],
      [
        orphan,
        {
          hostThreadId: orphan,
          forkSource: {
            hostThreadId: hostThreadIdSchema.parse("missing-source"),
            hostTurnId: hostTurnIdSchema.parse("missing-turn"),
          },
        },
      ],
    ]);
    const repository = new ExternalThreadRepository({
      getThread: async (threadId) => records.get(threadId) as StoredThreadRecordV1,
      getDelegationByChild: async (threadId) =>
        threadId === delegated
          ? ({ executionPolicy: "unattended-full-access" } as never)
          : threadId === legacy
            ? ({} as never)
            : null,
    } as never);

    await expect(
      repository.executionPolicyForThread(records.get(delegated) as StoredThreadRecordV1),
    ).resolves.toBe("unattended-full-access");
    await expect(
      repository.executionPolicyForThread(records.get(legacy) as StoredThreadRecordV1),
    ).resolves.toBe("approval-required");
    await expect(
      repository.executionPolicyForThread(records.get(ordinary) as StoredThreadRecordV1),
    ).resolves.toBe("default");
    await expect(
      repository.executionPolicyForThread(records.get(derived) as StoredThreadRecordV1),
    ).resolves.toBe("unattended-full-access");
    await expect(
      repository.executionPolicyForThread(records.get(orphan) as StoredThreadRecordV1),
    ).rejects.toThrow("policy lineage is incomplete");
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
