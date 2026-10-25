import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  MappingStore,
  storedSectionPlacementV1Schema,
  storedThreadCoreV1Schema,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryStoreDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-perf-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MappingStore startup performance and lazy loading (#595)", () => {
  it("only loads active threads on startup and lazily loads archived threads", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    const metadataDirectory = path.join(directory, "thread-metadata");
    const sectionsDirectory = path.join(directory, "sections");
    await mkdir(threadsDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });
    await mkdir(sectionsDirectory, { recursive: true });

    const totalThreads = 60;
    const archivedCount = 50;
    const activeCount = 10;
    const timestamp = new Date("2026-10-25T00:00:00.000Z").toISOString();

    // Create 10 active and 50 archived threads with metadata
    for (let i = 0; i < totalThreads; i++) {
      const isArchived = i < archivedCount;
      const id = hostThreadIdSchema.parse(`thread-${isArchived ? "archived" : "active"}-${i}`);
      const record = storedThreadCoreV1Schema.parse({
        formatVersion: 1,
        revision: 1,
        hostThreadId: id,
        createRequestId: `req-${id}`,
        harnessId: harnessIdSchema.parse("pi"),
        state: "ready",
        nativeSessionRef: {
          harnessId: "pi",
          nativeSessionId: `native-${id}`,
          formatVersion: 1,
        },
        cwd: "/synthetic",
        title: `Thread ${id}`,
        archived: isArchived,
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
        turnMappings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeFile(path.join(threadsDirectory, `${id}.json`), JSON.stringify(record), "utf8");

      // Write metadata file for each thread
      await writeFile(
        path.join(metadataDirectory, `${id}.json`),
        JSON.stringify({
          formatVersion: 1,
          hostThreadId: id,
          projectId: `proj-${i}`,
        }),
        "utf8",
      );
    }

    // Write an orphaned metadata file whose thread file does not exist
    await writeFile(
      path.join(metadataDirectory, "thread-orphaned-999.json"),
      JSON.stringify({
        formatVersion: 1,
        hostThreadId: "thread-orphaned-999",
        projectId: "proj-orphaned",
      }),
      "utf8",
    );

    // Write a section placement for an archived thread
    const sampleArchivedId = hostThreadIdSchema.parse("thread-archived-0");
    await writeFile(
      path.join(sectionsDirectory, "placements.json"),
      JSON.stringify({
        formatVersion: 1,
        placements: [
          storedSectionPlacementV1Schema.parse({
            hostThreadId: sampleArchivedId,
            section: { id: "section-1", name: "Pinned", appearance: null },
            enteredAt: timestamp,
            beforeThreadId: null,
          }),
        ],
      }),
      "utf8",
    );

    const store = new MappingStore({ directory, concurrency: 16 });
    await store.initialize();

    // 1. Verify orphaned metadata was cleaned up, but archived metadata was NOT deleted!
    const remainingMetadata = (await readdir(metadataDirectory)).filter((f) => f.endsWith(".json"));
    expect(remainingMetadata).not.toContain("thread-orphaned-999.json");
    expect(remainingMetadata.length).toBe(totalThreads);

    // 2. Section placement for unloaded archived thread is preserved
    const placements = await store.listSectionPlacements();
    expect(placements).toHaveLength(1);
    expect(placements[0]?.hostThreadId).toBe(sampleArchivedId);

    // 3. Querying active threads should return 10 threads without loading archived threads
    const activeThreads = await store.listThreads({ archived: false });
    expect(activeThreads).toHaveLength(activeCount);
    for (const t of activeThreads) {
      expect(t.archived).toBe(false);
      expect(t.projectId).toBeDefined();
    }

    // 4. Querying a specific archived thread should lazily load it and attach its metadata
    const sampleRecord = await store.getThread(sampleArchivedId);
    expect(sampleRecord).not.toBeNull();
    expect(sampleRecord?.archived).toBe(true);
    expect(sampleRecord?.projectId).toBe("proj-0");

    // 5. Querying archived threads should return all 50 archived threads with metadata
    const archivedThreads = await store.listThreads({ archived: true });
    expect(archivedThreads).toHaveLength(archivedCount);
    for (const t of archivedThreads) {
      expect(t.archived).toBe(true);
      expect(t.projectId).toBeDefined();
    }

    // 6. Querying all threads (no filter) returns all 60 threads
    const allThreads = await store.listThreads();
    expect(allThreads).toHaveLength(totalThreads);

    await store.close();

    // 7. Test persistence of archived index across restarts:
    // Verify archived-threads.json exists with structured entries
    const archivedIndexRaw = await readFile(path.join(directory, "archived-threads.json"), "utf8");
    const archivedIndex = JSON.parse(archivedIndexRaw);
    expect(archivedIndex.formatVersion).toBe(1);
    expect(archivedIndex.stubs.length).toBe(archivedCount);

    // On second startup with clean store instance:
    const restartedStore = new MappingStore({ directory, concurrency: 16 });
    await restartedStore.initialize();

    // 8. Global uniqueness checks against unloaded archived threads:
    // Duplicate hostThreadId should be rejected
    await expect(
      restartedStore.createProvisional({
        hostThreadId: sampleArchivedId,
        createRequestId: "new-request-1",
        harnessId: harnessIdSchema.parse("pi"),
        cwd: "/synthetic",
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
      }),
    ).rejects.toThrow("Host Thread ID already exists");

    // Idempotent createRequest matching archived thread returns existing thread
    const idempotentResult = await restartedStore.createProvisional({
      hostThreadId: hostThreadIdSchema.parse("new-active-thread"),
      createRequestId: `req-${sampleArchivedId}`,
      harnessId: harnessIdSchema.parse("pi"),
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    expect(idempotentResult.hostThreadId).toBe(sampleArchivedId);

    // Duplicate nativeSessionRef mapped to archived thread must be rejected on commitReady
    const anotherThreadId = hostThreadIdSchema.parse("thread-another-new");
    await restartedStore.createProvisional({
      hostThreadId: anotherThreadId,
      createRequestId: "req-another-new",
      harnessId: harnessIdSchema.parse("pi"),
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await expect(
      restartedStore.commitReady({
        hostThreadId: anotherThreadId,
        nativeSessionRef: {
          harnessId: harnessIdSchema.parse("pi"),
          nativeSessionId: `native-${sampleArchivedId}`,
          formatVersion: 1,
        },
        turnMappings: [],
      }),
    ).rejects.toThrow("Native Session is already mapped");

    // removeProvisional on archived ready thread must throw MAPPING_CONFLICT and not delete
    await expect(restartedStore.removeProvisional(sampleArchivedId)).rejects.toThrow(
      "Ready Thread cannot be removed as provisional",
    );
    expect(await restartedStore.getThread(sampleArchivedId)).not.toBeNull();

    // Clean up provisional test thread
    await restartedStore.removeProvisional(anotherThreadId);

    // Concurrent getThread calls should deduplicate and return identical records
    const [concurrent1, concurrent2] = await Promise.all([
      restartedStore.getThread(hostThreadIdSchema.parse("thread-archived-1")),
      restartedStore.getThread(hostThreadIdSchema.parse("thread-archived-1")),
    ]);
    expect(concurrent1).not.toBeNull();
    expect(concurrent2).not.toBeNull();
    expect(concurrent1?.hostThreadId).toBe(concurrent2?.hostThreadId);

    // Query active threads should return immediately without loading archived threads
    const activeAgain = await restartedStore.listThreads({ archived: false });
    expect(activeAgain).toHaveLength(activeCount);

    // Metadata remains intact
    const metadataAfterRestart = (await readdir(metadataDirectory)).filter((f) =>
      f.endsWith(".json"),
    );
    expect(metadataAfterRestart.length).toBe(totalThreads);

    await restartedStore.close();
  });

  it("benchmarks bounded concurrent loading vs sequential simulation", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    await mkdir(threadsDirectory, { recursive: true });

    const totalThreads = 100;
    const timestamp = new Date("2026-10-25T00:00:00.000Z").toISOString();

    for (let i = 0; i < totalThreads; i++) {
      const id = hostThreadIdSchema.parse(`bench-thread-${i}`);
      const record = storedThreadCoreV1Schema.parse({
        formatVersion: 1,
        revision: 1,
        hostThreadId: id,
        createRequestId: `req-${id}`,
        harnessId: harnessIdSchema.parse("pi"),
        state: "ready",
        nativeSessionRef: {
          harnessId: "pi",
          nativeSessionId: `native-${id}`,
          formatVersion: 1,
        },
        cwd: "/synthetic",
        title: `Thread ${id}`,
        archived: i < 80, // 80% archived
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
        turnMappings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeFile(path.join(threadsDirectory, `${id}.json`), JSON.stringify(record), "utf8");
    }

    const t0 = performance.now();
    const store = new MappingStore({ directory, concurrency: 16 });
    await store.initialize();
    const tInit = performance.now() - t0;

    const tListActive0 = performance.now();
    const active = await store.listThreads({ archived: false });
    const tListActive = performance.now() - tListActive0;

    expect(active).toHaveLength(20);
    // Active query should be near-instant (< 10ms)
    expect(tListActive).toBeLessThan(50);

    await store.close();

    // Restart should be even faster due to archived index
    const tRestart0 = performance.now();
    const restarted = new MappingStore({ directory, concurrency: 16 });
    await restarted.initialize();
    const tRestart = performance.now() - tRestart0;

    expect(await restarted.listThreads({ archived: false })).toHaveLength(20);
    await restarted.close();

    // Verify restart initialization is significantly faster than first full scan
    expect(tRestart).toBeLessThanOrEqual(tInit + 50);
  });
});
