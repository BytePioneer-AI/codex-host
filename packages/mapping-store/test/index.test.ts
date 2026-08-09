import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type StoredThreadRecordV1,
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

function mappingForSession(sessionRef: NativeSessionRef, ordinal: number): StoredTurnMappingV1 {
  return {
    hostTurnId: hostTurnIdSchema.parse(`turn-${ordinal}`),
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId,
      nativeSessionId: sessionRef.nativeSessionId,
      nativeTurnKey: `native-turn-${ordinal}`,
      formatVersion: 1,
    }),
    nativeCheckpointRef: nativeCheckpointRefSchema.parse({
      harnessId,
      nativeSessionId: sessionRef.nativeSessionId,
      checkpointId: `checkpoint-${ordinal}`,
      formatVersion: 1,
    }),
  };
}

function mapping(ordinal: number): StoredTurnMappingV1 {
  return mappingForSession(nativeRef, ordinal);
}

async function createReady(
  store: MappingStore,
  forkSource?: NonNullable<StoredThreadRecordV1["forkSource"]>,
): Promise<void> {
  await store.createProvisional({
    hostThreadId: threadId,
    createRequestId: "create-1",
    harnessId,
    cwd: "/synthetic",
    title: "External Thread",
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    ...(forkSource ? { forkSource } : {}),
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

  it("reconciles middle-inserted Turn mappings in complete Snapshot order", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory });
    await first.initialize();
    await createReady(first);
    await first.upsertTurnMappings(threadId, [mapping(4)]);
    const before = await first.getThread(threadId);

    const ordered = [mapping(1), mapping(2), mapping(3), mapping(4)];
    const reconciled = await first.reconcileTurnMappings(threadId, ordered);
    expect(reconciled.turnMappings).toEqual(ordered);
    expect(reconciled.revision).toBe((before?.revision ?? 0) + 1);

    const repeated = await first.reconcileTurnMappings(threadId, ordered);
    expect(repeated).toEqual(reconciled);
    await first.close();

    const second = new MappingStore({ directory });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toMatchObject({
      revision: reconciled.revision,
      turnMappings: ordered,
    });

    const changedCheckpoint = {
      ...mapping(1),
      nativeCheckpointRef: {
        ...mapping(1).nativeCheckpointRef,
        checkpointId: "changed-checkpoint",
      },
    } as StoredTurnMappingV1;
    const invalidSets = [
      [mapping(1), mapping(2), mapping(4)],
      [mapping(1), mapping(3), mapping(2), mapping(4)],
      [{ ...mapping(1), nativeTurnRef: mapping(4).nativeTurnRef }, ...ordered.slice(1)],
      [changedCheckpoint, ...ordered.slice(1)],
    ];
    for (const invalid of invalidSets) {
      await expect(second.reconcileTurnMappings(threadId, invalid)).rejects.toMatchObject({
        code: "MAPPING_CONFLICT",
      });
    }
    await expect(second.getThread(threadId)).resolves.toEqual(reconciled);
    await second.close();
  });

  it("keeps prior mappings when ordered reconciliation replacement fails", async () => {
    const directory = await temporaryStoreDirectory();
    let fail = false;
    const store = new MappingStore({
      directory,
      beforeReplace() {
        if (fail) throw new Error("synthetic reconciliation failure");
      },
    });
    await store.initialize();
    await createReady(store);
    await store.upsertTurnMappings(threadId, [mapping(3)]);
    const before = await store.getThread(threadId);
    fail = true;

    await expect(
      store.reconcileTurnMappings(threadId, [mapping(1), mapping(2), mapping(3)]),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(store.getThread(threadId)).resolves.toEqual(before);
    const persisted = JSON.parse(
      await readFile(path.join(directory, "threads", `${threadId}.json`), "utf8"),
    ) as StoredThreadRecordV1;
    expect(persisted.turnMappings).toEqual([mapping(1), mapping(3)]);
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

  it("atomically replaces a ready derived Session and keeps the prior record on failure", async () => {
    const directory = await temporaryStoreDirectory();
    let fail = false;
    const store = new MappingStore({
      directory,
      beforeReplace() {
        if (fail) throw new Error("synthetic replacement failure");
      },
    });
    await store.initialize();
    const sourceThreadId = hostThreadIdSchema.parse("source-thread");
    await createReady(store, {
      hostThreadId: sourceThreadId,
      hostTurnId: hostTurnIdSchema.parse("source-turn-3"),
    });
    await store.upsertTurnMappings(threadId, [mapping(2), mapping(3)]);
    const replacementRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-2",
      locator: { sessionFile: "/synthetic/replacement.jsonl" },
      formatVersion: 1,
    }) as NativeSessionRef;
    const replacementMappings = [
      mappingForSession(replacementRef, 1),
      mappingForSession(replacementRef, 2),
    ];
    const replaced = await store.replaceReadySession({
      hostThreadId: threadId,
      nativeSessionRef: replacementRef,
      turnMappings: replacementMappings,
      forkSource: {
        hostThreadId: sourceThreadId,
        hostTurnId: hostTurnIdSchema.parse("source-turn-2"),
      },
    });
    expect(replaced).toMatchObject({
      nativeSessionRef: replacementRef,
      turnMappings: replacementMappings,
      forkSource: {
        hostThreadId: sourceThreadId,
        hostTurnId: hostTurnIdSchema.parse("source-turn-2"),
      },
    });

    fail = true;
    const failedRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-3",
      formatVersion: 1,
    }) as NativeSessionRef;
    await expect(
      store.replaceReadySession({
        hostThreadId: threadId,
        nativeSessionRef: failedRef,
        turnMappings: [mappingForSession(failedRef, 1)],
        forkSource: { hostThreadId: sourceThreadId, hostTurnId: mapping(1).hostTurnId },
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(store.getThread(threadId)).resolves.toMatchObject({
      nativeSessionRef: replacementRef,
      turnMappings: replacementMappings,
    });
    await store.close();
  });

  it("atomically replaces the only Turn with an empty ready Session", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory, instanceId: "first" });
    await first.initialize();
    const forkSource = {
      hostThreadId: hostThreadIdSchema.parse("source-thread"),
      hostTurnId: hostTurnIdSchema.parse("source-turn"),
    };
    await createReady(first, forkSource);
    const before = await first.getThread(threadId);
    const replacementRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-empty",
      locator: { sessionFile: "/synthetic/empty.jsonl" },
      formatVersion: 1,
    }) as NativeSessionRef;

    const replaced = await first.replaceReadySessionAfterLastTurn({
      hostThreadId: threadId,
      nativeSessionRef: replacementRef,
      turnMappings: [],
    });
    expect(replaced).toMatchObject({
      revision: (before?.revision ?? 0) + 1,
      nativeSessionRef: replacementRef,
      turnMappings: [],
      forkSource,
      title: "External Thread",
      transportModelId: "codexhost/pi-native",
    });
    await first.close();

    const second = new MappingStore({ directory, instanceId: "second" });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toEqual(replaced);
    await second.close();
  });

  it("keeps the latest ready Session authoritative when last-Turn replacement fails", async () => {
    const directory = await temporaryStoreDirectory();
    let fail = false;
    const store = new MappingStore({
      directory,
      beforeReplace() {
        if (fail) throw new Error("synthetic last-Turn replacement failure");
      },
    });
    await store.initialize();
    await createReady(store);
    await store.upsertTurnMappings(threadId, [mapping(2), mapping(3)]);
    const replacementRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-shorter",
      formatVersion: 1,
    }) as NativeSessionRef;
    const replaced = await store.replaceReadySessionAfterLastTurn({
      hostThreadId: threadId,
      nativeSessionRef: replacementRef,
      turnMappings: [mappingForSession(replacementRef, 1), mappingForSession(replacementRef, 2)],
    });

    fail = true;
    const failedRef = nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-session-failed",
      formatVersion: 1,
    }) as NativeSessionRef;
    await expect(
      store.replaceReadySessionAfterLastTurn({
        hostThreadId: threadId,
        nativeSessionRef: failedRef,
        turnMappings: [mappingForSession(failedRef, 1)],
      }),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(store.getThread(threadId)).resolves.toEqual(replaced);
    const persisted = JSON.parse(
      await readFile(path.join(directory, "threads", `${threadId}.json`), "utf8"),
    ) as StoredThreadRecordV1;
    expect(persisted).toEqual(replaced);
    await store.close();
  });

  it("persists the current transport configuration", async () => {
    const directory = await temporaryStoreDirectory();
    const first = new MappingStore({ directory });
    await first.initialize();
    await createReady(first);
    await first.setTransportModelId(
      threadId,
      "codexhost/claude-code-native@claude-model-v1.default@acceptEdits",
    );
    await first.close();

    const second = new MappingStore({ directory });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toMatchObject({
      transportModelId: "codexhost/claude-code-native@claude-model-v1.default@acceptEdits",
    });
    await second.close();
  });

  it("persists archive state atomically and treats matching state as a no-op", async () => {
    const directory = await temporaryStoreDirectory();
    let replacements = 0;
    const first = new MappingStore({
      directory,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      beforeReplace() {
        replacements += 1;
      },
    });
    await first.initialize();
    await createReady(first);
    const before = await first.getThread(threadId);
    const archived = await first.setArchived(threadId, true);
    expect(archived).toMatchObject({ archived: true, revision: (before?.revision ?? 0) + 1 });
    const afterChangeReplacements = replacements;
    const unchanged = await first.setArchived(threadId, true);
    expect(unchanged).toEqual(archived);
    expect(replacements).toBe(afterChangeReplacements);
    await first.close();

    const second = new MappingStore({ directory });
    await second.initialize();
    await expect(second.getThread(threadId)).resolves.toMatchObject({ archived: true });
    await second.setArchived(threadId, false);
    await second.close();

    const third = new MappingStore({ directory });
    await third.initialize();
    await expect(third.getThread(threadId)).resolves.toMatchObject({ archived: false });
    await third.close();
  });

  it("keeps prior archive state and Revision when archive replacement fails", async () => {
    const directory = await temporaryStoreDirectory();
    let fail = false;
    const store = new MappingStore({
      directory,
      beforeReplace() {
        if (fail) throw new Error("synthetic archive failure");
      },
    });
    await store.initialize();
    await createReady(store);
    const before = await store.getThread(threadId);
    fail = true;
    await expect(store.setArchived(threadId, true)).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(store.getThread(threadId)).resolves.toEqual(before);
    await store.close();
  });

  it("returns defensive content-free enumeration copies", async () => {
    const directory = await temporaryStoreDirectory();
    const store = new MappingStore({ directory });
    await store.initialize();
    await createReady(store);
    const records = await store.listThreads();
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toMatch(
      /prompt|transcript|toolOutput|diff|usage|apiKey|accessToken/iu,
    );
    const returned = records[0];
    if (!returned) throw new Error("Expected one enumerated record");
    returned.title = "mutated caller copy";
    returned.turnMappings.length = 0;
    await expect(store.getThread(threadId)).resolves.toMatchObject({
      title: "External Thread",
      turnMappings: [mapping(1)],
    });
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

  it("enumerates 1000 valid startup records without a persistent query index", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    await mkdir(threadsDirectory, { recursive: true });
    const timestamp = new Date("2026-08-01T00:00:00.000Z").toISOString();
    await Promise.all(
      Array.from({ length: 1_000 }, async (_, index) => {
        const id = `scale-thread-${index.toString().padStart(4, "0")}`;
        const record = storedThreadRecordV1Schema.parse({
          formatVersion: 1,
          revision: 1,
          hostThreadId: id,
          createRequestId: `scale-create-${index}`,
          harnessId,
          state: "ready",
          nativeSessionRef: {
            harnessId,
            nativeSessionId: `scale-native-${index}`,
            formatVersion: 1,
          },
          cwd: "/scale",
          title: `Scale Thread ${index}`,
          archived: false,
          transportModelId: "codexhost/pi-native",
          ephemeral: false,
          historyMode: "legacy",
          turnMappings: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await writeFile(path.join(threadsDirectory, `${id}.json`), JSON.stringify(record), "utf8");
      }),
    );
    const store = new MappingStore({ directory });
    await store.initialize();
    await expect(store.listThreads()).resolves.toHaveLength(1_000);
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

  it("recovers a Windows lock whose PID was reused by another executable", async () => {
    if (process.platform !== "win32") return;
    const directory = await temporaryStoreDirectory();
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "store.lock"),
      `${JSON.stringify({
        pid: process.pid,
        instanceId: "legacy-owner",
        startedAt: new Date(0).toISOString(),
        executablePath: "C:\\\\Windows\\\\System32\\\\svchost.exe",
        processStartedAt: new Date(0).toISOString(),
      })}\n`,
      "utf8",
    );

    const store = new MappingStore({ directory, instanceId: "recovered" });
    await store.initialize();
    await store.close();
  });
});
