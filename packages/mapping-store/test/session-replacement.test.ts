import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const harnessId = harnessIdSchema.parse("pi");
const hostThreadId = hostThreadIdSchema.parse("target");
const sourceRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "source-session",
  formatVersion: 1,
  locator: { sessionFile: "/synthetic/source.jsonl" },
});
const replacementRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "replacement-session",
  formatVersion: 1,
});
const forkSource = {
  hostThreadId: hostThreadIdSchema.parse("parent"),
  hostTurnId: hostTurnIdSchema.parse("parent-turn-3"),
};
const resources: Array<{ directory: string; store: MappingStore }> = [];

afterEach(async () => {
  for (const { directory, store } of resources.splice(0)) {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe.each(["last-Turn", "Fork-derived"] as const)("%s replacement expectation", (kind) => {
  async function setup() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-replacement-"));
    const store = new MappingStore({ directory });
    resources.push({ directory, store });
    await store.initialize();
    await store.createProvisional({
      hostThreadId,
      createRequestId: "create-target",
      harnessId,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "paginated",
      forkSource,
    });
    const original = await store.commitReady({
      hostThreadId,
      nativeSessionRef: sourceRef,
      turnMappings: [1, 2, 3].map((ordinal) => ({
        hostTurnId: hostTurnIdSchema.parse(`turn-${ordinal}`),
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId,
          nativeSessionId: sourceRef.nativeSessionId,
          nativeTurnKey: `native-${ordinal}`,
          formatVersion: 1,
        }),
      })),
    });
    const input = {
      hostThreadId,
      expectedRevision: original.revision,
      expectedNativeSessionRef: sourceRef,
      nativeSessionRef: replacementRef,
      turnMappings: original.turnMappings.slice(0, -1).map((mapping) => ({
        ...mapping,
        nativeTurnRef: {
          ...mapping.nativeTurnRef,
          nativeSessionId: replacementRef.nativeSessionId,
        },
      })),
      forkSource: { ...forkSource, hostTurnId: hostTurnIdSchema.parse("parent-turn-2") },
    };
    const replace =
      kind === "last-Turn"
        ? store.replaceReadySessionAfterLastTurn.bind(store)
        : store.replaceReadySession.bind(store);
    return { directory, store, original, input, replace };
  }

  it("rejects a stale edit after an earlier queued configuration write without losing indexes", async () => {
    const { directory, store, original, input, replace } = await setup();
    // Both requests enter the Store queue before either has persisted.
    const updating = store.setTransportModelId(hostThreadId, "codexhost/pi-native@changed");
    const replacing = replace(input);
    await expect(replacing).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
    const updated = await updating;
    expect(updated.revision).toBe(original.revision + 1);
    await expect(store.getThread(hostThreadId)).resolves.toEqual(updated);
    expect(
      JSON.parse(await readFile(path.join(directory, "threads", "target.json"), "utf8")),
    ).toEqual(updated);
    for (const mapping of original.turnMappings) {
      await expect(store.findThreadByTurn(mapping.hostTurnId)).resolves.toEqual(updated);
    }
    // A new operation can use the latest expectation; a conflict does not poison the queue.
    const committed = await replace({ ...input, expectedRevision: updated.revision });
    expect(committed.nativeSessionRef).toEqual(replacementRef);
    await expect(store.findThreadByTurn(hostTurnIdSchema.parse("turn-3"))).resolves.toBeNull();
  });

  it.each(["identity", "locator"] as const)(
    "rejects a mismatched source %s at the current revision",
    async (difference) => {
      const { directory, store, original, input, replace } = await setup();
      const expectedNativeSessionRef = nativeSessionRefSchema.parse({
        ...sourceRef,
        ...(difference === "identity"
          ? { nativeSessionId: "another-session" }
          : { locator: { sessionFile: "/synthetic/other.jsonl" } }),
      });
      await expect(replace({ ...input, expectedNativeSessionRef })).rejects.toMatchObject({
        code: "MAPPING_CONFLICT",
      });
      await expect(store.getThread(hostThreadId)).resolves.toEqual(original);
      expect(
        JSON.parse(await readFile(path.join(directory, "threads", "target.json"), "utf8")),
      ).toEqual(original);
    },
  );
});
