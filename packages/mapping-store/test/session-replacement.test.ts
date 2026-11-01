import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("remembers the Native Session the Thread left, across restarts and Thread removal", async () => {
    const { directory, store, original, input, replace } = await setup();
    expect(store.supersededNativeSessionIds(harnessId)).toEqual([]);
    // A rejected replacement leaves nothing behind.
    await expect(
      replace({ ...input, expectedRevision: original.revision + 5 }),
    ).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
    expect(store.supersededNativeSessionIds(harnessId)).toEqual([]);

    await replace(input);
    expect(store.supersededNativeSessionIds(harnessId)).toEqual(["source-session"]);
    // The same Session ID under another Harness is a different Session.
    expect(store.supersededNativeSessionIds(harnessIdSchema.parse("omp"))).toEqual([]);
    const file = path.join(directory, "superseded-sessions", "sessions.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      formatVersion: 1,
      sessions: [{ harnessId: "pi", nativeSessionId: "source-session", hostThreadId: "target" }],
    });
    // The Thread record keeps the shape older releases accept.
    expect(await readFile(path.join(directory, "threads", "target.json"), "utf8")).not.toContain(
      "source-session",
    );

    // An old version of a removed Thread is still nothing the user wants to import.
    await store.removeThread(hostThreadId);
    await store.close();
    const reopened = new MappingStore({ directory });
    resources.push({ directory, store: reopened });
    await reopened.initialize();
    expect(reopened.supersededNativeSessionIds(harnessId)).toEqual(["source-session"]);
  });

  it("keeps the replacement when the superseded record cannot be written and survives a corrupt file", async () => {
    const { directory, store, input, replace } = await setup();
    // A file where the directory belongs makes every write of the side file fail.
    await writeFile(path.join(directory, "superseded-sessions"), "not a directory");
    const committed = await replace(input);
    expect(committed.nativeSessionRef).toEqual(replacementRef);
    expect(store.supersededNativeSessionIds(harnessId)).toEqual([]);
    await store.close();

    await rm(path.join(directory, "superseded-sessions"));
    await mkdir(path.join(directory, "superseded-sessions"));
    await writeFile(path.join(directory, "superseded-sessions", "sessions.json"), "{broken");
    const reopened = new MappingStore({ directory });
    resources.push({ directory, store: reopened });
    await reopened.initialize();
    // Import suggestions are not worth blocking Thread access for.
    expect(reopened.supersededNativeSessionIds(harnessId)).toEqual([]);
    await expect(reopened.getThread(hostThreadId)).resolves.toMatchObject({
      nativeSessionRef: replacementRef,
    });
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
