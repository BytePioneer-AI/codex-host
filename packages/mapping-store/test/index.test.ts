import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  MappingStore,
  packageMetadata,
  storedThreadRecordV1Schema,
  type MappingStoreError,
  type StoredTurnMappingV1,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-mapping-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

const harnessId = harnessIdSchema.parse("pi");
const threadId = hostThreadIdSchema.parse("thread-1");
const nativeRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "native-session-1",
  locator: { sessionFile: "/synthetic/session.jsonl" },
  formatVersion: 1,
}) as NativeSessionRef;

function mapping(ordinal: number): StoredTurnMappingV1 {
  return {
    hostTurnId: hostTurnIdSchema.parse(`turn-${ordinal}`),
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId,
      nativeSessionId: nativeRef.nativeSessionId,
      nativeTurnKey: `native-turn-${ordinal}`,
      formatVersion: 1,
    }),
    nativeCheckpointRef: nativeCheckpointRefSchema.parse({
      harnessId,
      nativeSessionId: nativeRef.nativeSessionId,
      checkpointId: `checkpoint-${ordinal}`,
      formatVersion: 1,
    }),
  };
}

async function createReady(store: MappingStore): Promise<void> {
  await store.createProvisional({
    hostThreadId: threadId,
    createRequestId: "create-1",
    harnessId,
    cwd: "/synthetic",
    title: "External Thread",
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
  });
  await store.commitReady({
    hostThreadId: threadId,
    nativeSessionRef: nativeRef,
    turnMappings: [mapping(1)],
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("mapping-store package", () => {
  it("participates in the shared contract", () => {
    expect(packageMetadata.name).toBe("@codexhost/mapping-store");
    expect(packageMetadata.contractVersion).toBe(1);
  });

  it("persists strict identity and Desktop metadata across restart", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory, instanceId: "first" });
    await first.initialize();
    await createReady(first);
    await first.close();

    const second = new MappingStore({ directory, instanceId: "second" });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toMatchObject({
      hostThreadId: threadId,
      harnessId,
      state: "ready",
      nativeSessionRef: nativeRef,
      ephemeral: false,
      historyMode: "legacy",
      transportModelId: "codexhost/pi-native",
      turnMappings: [mapping(1)],
    });
    await second.close();
  });

  it("rejects content fields and cross-Session Checkpoints", () => {
    const base = {
      formatVersion: 1,
      revision: 1,
      hostThreadId: threadId,
      createRequestId: "create-1",
      harnessId,
      state: "ready",
      nativeSessionRef: nativeRef,
      cwd: "/synthetic",
      title: "External",
      archived: false,
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
      turnMappings: [mapping(1)],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    expect(storedThreadRecordV1Schema.safeParse({ ...base, transcript: "secret" }).success).toBe(
      false,
    );
    expect(
      storedThreadRecordV1Schema.safeParse({
        ...base,
        turnMappings: [
          {
            ...mapping(1),
            nativeCheckpointRef: {
              ...mapping(1).nativeCheckpointRef,
              nativeSessionId: "another-session",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects conflicting Host and Native Turn mappings without changing state", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    await store.initialize();
    await createReady(store);

    await expect(
      store.upsertTurnMappings(threadId, [
        {
          ...mapping(2),
          hostTurnId: mapping(1).hostTurnId,
        },
      ]),
    ).rejects.toMatchObject({ code: "MAPPING_CONFLICT" });
    await expect(store.getThread(threadId)).resolves.toMatchObject({ turnMappings: [mapping(1)] });
    await store.close();
  });

  it("keeps the prior durable and in-memory record when replacement fails", async () => {
    const directory = await temporaryStoreDirectory();
    let fail = false;
    const store = new MappingStore({
      directory,
      beforeReplace() {
        if (fail) throw new Error("synthetic disk failure");
      },
    });
    await store.initialize();
    await createReady(store);
    fail = true;

    await expect(store.setTitle(threadId, "not committed")).rejects.toMatchObject({
      code: "IO_ERROR",
    });
    await expect(store.getThread(threadId)).resolves.toMatchObject({ title: "External Thread" });
    const persisted = JSON.parse(
      await readFile(path.join(directory, "threads", `${threadId}.json`), "utf8"),
    ) as { title: string };
    expect(persisted.title).toBe("External Thread");
    await store.close();
  });

  it("recovers a malformed primary from the latest valid backup", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory });
    await first.initialize();
    await createReady(first);
    await first.setTitle(threadId, "latest title");
    await first.close();

    await writeFile(path.join(directory, "threads", `${threadId}.json`), "{broken", "utf8");
    const recovered = new MappingStore({ directory });
    await recovered.initialize();
    await expect(recovered.getThread(threadId)).resolves.toMatchObject({
      title: "External Thread",
    });
    await recovered.close();
  });

  it("cleans a provisional create without Native identity on restart", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory });
    await first.initialize();
    await first.createProvisional({
      hostThreadId: threadId,
      createRequestId: "provisional",
      harnessId,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
      forkSource: {
        hostThreadId: hostThreadIdSchema.parse("source-thread"),
        hostTurnId: hostTurnIdSchema.parse("source-turn"),
      },
    });
    await first.close();

    const second = new MappingStore({ directory });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toBeNull();
    await second.close();
  });

  it("allows failed Fork commit cleanup while retaining the source", async () => {
    const directory = await temporaryStoreDirectory();
    let failDerivedCommit = false;
    const store = new MappingStore({
      directory,
      beforeReplace(record) {
        if (
          failDerivedCommit &&
          record.hostThreadId === "derived-thread" &&
          record.state === "ready"
        ) {
          throw new Error("synthetic Fork commit failure");
        }
      },
    });
    await store.initialize();
    await createReady(store);
    const derivedId = hostThreadIdSchema.parse("derived-thread");
    await store.createProvisional({
      hostThreadId: derivedId,
      createRequestId: "fork-create",
      harnessId,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
      forkSource: { hostThreadId: threadId, hostTurnId: mapping(1).hostTurnId },
    });
    failDerivedCommit = true;
    await expect(
      store.commitReady({
        hostThreadId: derivedId,
        nativeSessionRef: {
          harnessId: nativeRef.harnessId,
          nativeSessionId: "derived-native",
          locator: { sessionFile: "/synthetic/derived.jsonl" },
          formatVersion: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await store.removeProvisional(derivedId);
    await expect(store.getThread(derivedId)).resolves.toBeNull();
    await expect(store.getThread(threadId)).resolves.toMatchObject({ state: "ready" });
    await store.close();
  });

  it("removes a ready Thread and releases its global indexes", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    await store.initialize();
    await createReady(store);

    await store.removeThread(threadId);
    await expect(store.getThread(threadId)).resolves.toBeNull();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "replacement-create",
      harnessId,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.close();
  });

  it("enforces one live writer per directory", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory, instanceId: "first" });
    const second = new MappingStore({ directory, instanceId: "second" });
    await first.initialize();
    await expect(second.initialize()).rejects.toEqual(
      expect.objectContaining<Partial<MappingStoreError>>({ code: "STORE_LOCKED" }),
    );
    await first.close();
  });
});
