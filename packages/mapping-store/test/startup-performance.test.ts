import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore, storedThreadCoreV1Schema } from "../src/index.js";

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

describe("MappingStore bounded concurrent startup (#595)", () => {
  it("loads all threads and metadata concurrently with bounded concurrency", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    const metadataDirectory = path.join(directory, "thread-metadata");
    await mkdir(threadsDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });

    const totalThreads = 50;
    const timestamp = new Date("2026-10-25T00:00:00.000Z").toISOString();

    for (let i = 0; i < totalThreads; i++) {
      const id = hostThreadIdSchema.parse(`thread-${i}`);
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
        archived: i % 2 === 0,
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
        turnMappings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeFile(path.join(threadsDirectory, `${id}.json`), JSON.stringify(record), "utf8");

      if (i < 20) {
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
    }

    // Write an orphaned metadata file whose thread does not exist
    await writeFile(
      path.join(metadataDirectory, "orphaned-thread-999.json"),
      JSON.stringify({
        formatVersion: 1,
        hostThreadId: "orphaned-thread-999",
        projectId: "proj-orphaned",
      }),
      "utf8",
    );

    const store = new MappingStore({ directory, concurrency: 8 });
    await store.initialize();

    const threads = await store.listThreads();
    expect(threads).toHaveLength(totalThreads);

    // Verify metadata was attached to records that had metadata
    const thread0 = await store.getThread(hostThreadIdSchema.parse("thread-0"));
    expect(thread0?.projectId).toBe("proj-0");

    // Verify orphaned metadata was cleaned up
    const remainingMetadata = (await readdir(metadataDirectory)).filter((f) => f.endsWith(".json"));
    expect(remainingMetadata).not.toContain("orphaned-thread-999.json");
    expect(remainingMetadata).toHaveLength(20);

    await store.close();
  });

  it("handles concurrency limits and normalizes invalid concurrency values", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    await mkdir(threadsDirectory, { recursive: true });

    // Invalid concurrency (NaN, negative, float) should safely fall back to valid concurrency
    const storeNaN = new MappingStore({ directory, concurrency: NaN });
    await storeNaN.initialize();
    await storeNaN.close();

    const storeNegative = new MappingStore({ directory, concurrency: -5 });
    await storeNegative.initialize();
    await storeNegative.close();
  });

  it("safely drains in-flight workers when initialization fails", async () => {
    const directory = await temporaryStoreDirectory();
    const threadsDirectory = path.join(directory, "threads");
    const metadataDirectory = path.join(directory, "thread-metadata");
    await mkdir(threadsDirectory, { recursive: true });
    await mkdir(metadataDirectory, { recursive: true });

    // Create 10 valid threads
    const timestamp = new Date("2026-10-25T00:00:00.000Z").toISOString();
    for (let i = 0; i < 10; i++) {
      const id = hostThreadIdSchema.parse(`drain-thread-${i}`);
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
        archived: false,
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "legacy",
        turnMappings: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await writeFile(path.join(threadsDirectory, `${id}.json`), JSON.stringify(record), "utf8");
    }

    // Create a conflict: make a metadata path into a directory so readFile throws EISDIR
    await mkdir(path.join(metadataDirectory, "drain-thread-0.json"), { recursive: true });

    const store = new MappingStore({ directory, concurrency: 4 });
    await expect(store.initialize()).rejects.toThrow();

    // After failure, workers must be drained and store lock released
    const secondStore = new MappingStore({ directory, concurrency: 4 });
    // Remove the blocking directory to allow second store to initialize
    await rm(path.join(metadataDirectory, "drain-thread-0.json"), { recursive: true, force: true });
    await secondStore.initialize();
    expect(await secondStore.listThreads()).toHaveLength(10);
    await secondStore.close();
  });
});
