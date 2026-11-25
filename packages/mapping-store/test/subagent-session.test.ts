import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const directories: string[] = [];
const harnessId = harnessIdSchema.parse("antigravity");
const parentId = hostThreadIdSchema.parse("parent");
const childId = hostThreadIdSchema.parse("child");
const source = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "source",
  formatVersion: 1,
});
const replacement = nativeSessionRefSchema.parse({ ...source, nativeSessionId: "replacement" });
const rebind = {
  hostThreadId: childId,
  parentHostThreadId: parentId,
  previousNativeSessionRef: source,
  nativeSessionRef: replacement,
  createRequestId: "replacement-child",
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mapping-subagents-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  await store.initialize();
  const input = {
    harnessId,
    cwd: "/synthetic",
    transportModelId: "codexhost/antigravity-native",
    ephemeral: false,
    historyMode: "paginated" as const,
  };
  await store.createProvisional({ ...input, hostThreadId: parentId, createRequestId: "parent" });
  await store.commitReady({ hostThreadId: parentId, nativeSessionRef: replacement });
  await store.createProvisional({
    ...input,
    hostThreadId: childId,
    createRequestId: "source-child",
    subagent: { parentHostThreadId: parentId, nativeSubagentId: "native-child" },
  });
  const child = await store.commitReady({
    hostThreadId: childId,
    nativeSessionRef: source,
    turnMappings: [
      {
        hostTurnId: hostTurnIdSchema.parse("child-turn"),
        nativeTurnRef: nativeTurnRefSchema.parse({ ...source, nativeTurnKey: "native-child:turn" }),
        nativeCheckpointRef: nativeCheckpointRefSchema.parse({
          ...source,
          checkpointId: "checkpoint",
        }),
      },
    ],
  });
  return { store, child };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Native child Session rebinding", () => {
  it("atomically preserves child and Turn identities while rebinding native refs and request lookup", async () => {
    const { store, child } = await fixture();
    try {
      const results = await Promise.all([
        store.rebindSubagentSession(rebind),
        store.rebindSubagentSession(rebind),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        hostThreadId: childId,
        nativeSessionRef: replacement,
        turnMappings: [
          {
            hostTurnId: child.turnMappings[0]?.hostTurnId,
            nativeTurnRef: { nativeSessionId: "replacement", nativeTurnKey: "native-child:turn" },
            nativeCheckpointRef: { nativeSessionId: "replacement", checkpointId: "checkpoint" },
          },
        ],
      });
      expect(await store.getThreadByCreateRequest("source-child")).toBeNull();
      expect(await store.getThreadByCreateRequest("replacement-child")).toEqual(results[0]);
    } finally {
      await store.close();
    }
  });

  it.each([
    { parentHostThreadId: hostThreadIdSchema.parse("other") },
    {
      previousNativeSessionRef: nativeSessionRefSchema.parse({
        ...source,
        nativeSessionId: "other",
      }),
    },
    { nativeSessionRef: nativeSessionRefSchema.parse({ ...replacement, harnessId: "grok" }) },
    {
      nativeSessionRef: nativeSessionRefSchema.parse({
        ...replacement,
        nativeSessionId: "not-the-parent-session",
      }),
    },
    { hostThreadId: parentId },
  ])("rejects a stale or unrelated binding: %j", async (change) => {
    const { store, child } = await fixture();
    try {
      await expect(store.rebindSubagentSession({ ...rebind, ...change })).rejects.toMatchObject({
        code: "MAPPING_CONFLICT",
      });
      expect(await store.getThread(childId)).toEqual(child);
      expect(await store.getThreadByCreateRequest("replacement-child")).toBeNull();
    } finally {
      await store.close();
    }
  });
});
