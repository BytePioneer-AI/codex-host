import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MappingStore, type StoredTurnMappingV1 } from "../src/index.js";

const threadId = hostThreadIdSchema.parse("agy-thread");
const nativeSessionRef = nativeSessionRefSchema.parse({
  harnessId: "antigravity",
  nativeSessionId: "agy-session",
  formatVersion: 1,
});
const forkSource = {
  hostThreadId: hostThreadIdSchema.parse("source"),
  hostTurnId: hostTurnIdSchema.parse("source-turn"),
};

function mapping(checkpoint: number, key = checkpoint): StoredTurnMappingV1 {
  return {
    hostTurnId: hostTurnIdSchema.parse(`host-${key}`),
    nativeTurnRef: { ...nativeSessionRef, nativeTurnKey: `turn-${key}` },
    nativeCheckpointRef: { ...nativeSessionRef, checkpointId: `turn-${checkpoint}` },
  };
}

describe("Antigravity boundary repair", () => {
  let directory: string;
  let store: MappingStore;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "codexhost-agy-repair-"));
    store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "create-agy",
      harnessId: nativeSessionRef.harnessId,
      cwd: "/synthetic",
      transportModelId: "test-model",
      ephemeral: false,
      historyMode: "legacy",
      forkSource,
    });
  });
  afterEach(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("moves a chain of displaced keys atomically without changing Host IDs, checkpoints or Fork lineage", async () => {
    const original = await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef,
      turnMappings: [mapping(0), mapping(377, 594), mapping(594, 595)],
    });
    const corrected = [
      mapping(0),
      { ...mapping(377), hostTurnId: hostTurnIdSchema.parse("host-594") },
      { ...mapping(594), hostTurnId: hostTurnIdSchema.parse("host-595") },
    ];
    // The ordinary APIs cannot rebind the very same mappings.
    await expect(store.reconcileTurnMappings(threadId, corrected)).rejects.toMatchObject({
      code: "MAPPING_CONFLICT",
    });
    await expect(store.upsertTurnMappings(threadId, corrected)).rejects.toMatchObject({
      code: "MAPPING_CONFLICT",
    });
    await expect(
      store.repairAntigravityTurnMappings(threadId, original.revision - 1, corrected),
    ).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
    const repaired = await store.repairAntigravityTurnMappings(
      threadId,
      original.revision,
      corrected,
    );
    expect(repaired).toEqual({
      ...original,
      revision: original.revision + 1,
      turnMappings: corrected,
    });
    expect(
      await store.repairAntigravityTurnMappings(threadId, repaired.revision, corrected),
    ).toEqual(repaired);
  });

  it.each([
    {
      reason: "the target is already correctly mapped",
      stored: [mapping(377, 594), mapping(377)],
      replayed: [mapping(377)],
    },
    {
      reason: "replay does not confirm the checkpoint",
      stored: [mapping(377, 594)],
      replayed: [mapping(377, 378)],
    },
    {
      reason: "reconciliation would drop an existing mapping",
      stored: [mapping(377, 594), mapping(400)],
      replayed: [mapping(377)],
    },
  ])("leaves the record untouched when $reason", async ({ stored, replayed }) => {
    const original = await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef,
      turnMappings: stored,
    });
    await expect(
      store.repairAntigravityTurnMappings(threadId, original.revision, replayed),
    ).rejects.toMatchObject({
      code: "MAPPING_CONFLICT",
    });
    expect(await store.getThread(threadId)).toEqual(original);
  });
});
