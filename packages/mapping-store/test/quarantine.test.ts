import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const directories: string[] = [];
const stores: MappingStore[] = [];
const harnessId = harnessIdSchema.parse("pi");
const corruptId = hostThreadIdSchema.parse("thread-corrupt");
const healthyId = hostThreadIdSchema.parse("thread-healthy");
const timestamp = 1_700_000_000_000;
const quarantineName = `${corruptId}.json.${timestamp}.invalid`;

function storeAt(directory: string, time = timestamp): MappingStore {
  const store = new MappingStore({ directory, now: () => new Date(time) });
  stores.push(store);
  return store;
}

async function fixture(withMetadata = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-mapping-quarantine-"));
  directories.push(directory);
  const store = storeAt(directory);
  await store.initialize();
  for (const hostThreadId of [corruptId, healthyId]) {
    await store.createProvisional({
      hostThreadId,
      createRequestId: `create-${hostThreadId}`,
      harnessId,
      cwd: "/synthetic",
      title: hostThreadId,
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.commitReady({
      hostThreadId,
      nativeSessionRef: nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: `native-${hostThreadId}`,
        formatVersion: 1,
      }),
      turnMappings: [],
    });
  }
  if (withMetadata) {
    await store.updateMetadata(corruptId, { projectId: "project-a", daybreakEnabled: true });
  }
  await store.close();
  const primary = path.join(directory, "threads", `${corruptId}.json`);
  const backup = path.join(directory, "backups", `${corruptId}.json`);
  const metadata = path.join(directory, "thread-metadata", `${corruptId}.json`);
  const quarantine = path.join(directory, "quarantine", quarantineName);
  const primaryContent = await readFile(primary, "utf8");
  let metadataContent: string | null = null;
  if (withMetadata) {
    metadataContent = `${JSON.stringify({
      ...JSON.parse(await readFile(metadata, "utf8")),
      futureField: { opaque: [false, "retained"] },
    })}\n`;
    await writeFile(metadata, metadataContent, "utf8");
  }
  await writeFile(primary, "{broken", "utf8");
  await writeFile(backup, "{broken", "utf8");
  return { directory, primary, backup, metadata, quarantine, primaryContent, metadataContent };
}

async function expectHealthy(store: MappingStore): Promise<void> {
  await expect(store.getThread(healthyId)).resolves.toMatchObject({ title: healthyId });
  await expect(store.getThread(corruptId)).resolves.toBeNull();
}

afterEach(async () => {
  // Restore directory permissions even if a permission-failure assertion fails.
  for (const directory of directories) {
    for (const name of ["threads", "thread-metadata", "quarantine"]) {
      await chmod(path.join(directory, name), 0o700);
    }
  }
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Thread quarantine failures", () => {
  it("preserves source metadata and healthy Threads across failed archival and restart", async () => {
    const f = await fixture();
    await mkdir(`${f.quarantine}.metadata`);
    await writeFile(path.join(`${f.quarantine}.metadata`, "occupied"), "", "utf8");
    const orphan = path.join(f.directory, "thread-metadata", "thread-gone.json");
    await writeFile(orphan, "{}", "utf8");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = storeAt(f.directory);
      await reopened.initialize();
      await expectHealthy(reopened);
      await expect(readFile(f.primary, "utf8")).resolves.toBe("{broken");
      await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
      await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
      await reopened.close();
    }

    await rm(`${f.quarantine}.metadata`, { recursive: true });
    const retried = storeAt(f.directory);
    await retried.initialize();
    await expectHealthy(retried);
    await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe(f.metadataContent);
    await expect(readFile(f.metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["file", "directory"])(
    "does not replace an existing quarantine %s or lose the source pair",
    async (kind) => {
      const f = await fixture();
      const occupied = kind === "file" ? f.quarantine : path.join(f.quarantine, "occupied");
      if (kind === "directory") await mkdir(f.quarantine);
      await writeFile(occupied, "existing archive", "utf8");
      const reopened = storeAt(f.directory);
      await reopened.initialize();
      await expectHealthy(reopened);
      await expect(readFile(occupied, "utf8")).resolves.toBe("existing archive");
      await expect(readFile(f.primary, "utf8")).resolves.toBe("{broken");
      await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
    },
  );

  it("retains an interrupted metadata copy and retries under a fresh archive name", async () => {
    const f = await fixture();
    await writeFile(`${f.quarantine}.metadata`, "{partial-copy", "utf8");
    const reopened = storeAt(f.directory);
    await reopened.initialize();
    await expectHealthy(reopened);
    await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
    await expect(readFile(f.primary, "utf8")).resolves.toBe("{broken");
    await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe("{partial-copy");
    await reopened.close();

    const retried = storeAt(f.directory, timestamp + 1);
    await retried.initialize();
    await expectHealthy(retried);
    const next = path.join(f.directory, "quarantine", `${corruptId}.json.${timestamp + 1}.invalid`);
    await expect(readFile(next, "utf8")).resolves.toBe("{broken");
    await expect(readFile(`${next}.metadata`, "utf8")).resolves.toBe(f.metadataContent);
    await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe("{partial-copy");
    await expect(readFile(f.metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the preserved metadata when the primary is repaired after failed quarantine", async () => {
    const f = await fixture();
    await mkdir(`${f.quarantine}.metadata`);
    const reopened = storeAt(f.directory);
    await reopened.initialize();
    await expectHealthy(reopened);
    await reopened.close();

    await writeFile(f.primary, f.primaryContent, "utf8");
    const repaired = storeAt(f.directory);
    await repaired.initialize();
    await expect(repaired.getThread(corruptId)).resolves.toMatchObject({
      projectId: "project-a",
      daybreakEnabled: true,
    });
    await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
  });

  it("recovers a valid backup together with its independent metadata", async () => {
    const f = await fixture();
    await writeFile(f.backup, f.primaryContent, "utf8");
    const reopened = storeAt(f.directory);
    await reopened.initialize();
    await expect(reopened.getThread(corruptId)).resolves.toMatchObject({
      projectId: "project-a",
      daybreakEnabled: true,
    });
    await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
    await expect(readdir(path.join(f.directory, "quarantine"))).resolves.toEqual([]);
  });

  it("quarantines a corrupt Thread with no metadata", async () => {
    const f = await fixture(false);
    const reopened = storeAt(f.directory);
    await reopened.initialize();
    await expectHealthy(reopened);
    await expect(readFile(f.quarantine, "utf8")).resolves.toBe("{broken");
    await expect(readdir(path.join(f.directory, "quarantine"))).resolves.toEqual([quarantineName]);
  });
});

// chmod does not enforce these directory permissions on Windows or for a root process.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "POSIX quarantine permission failures",
  () => {
    it.each([false, true])(
      "keeps healthy Threads available with an unwritable quarantine (metadata: %s)",
      async (withMetadata) => {
        const f = await fixture(withMetadata);
        await chmod(path.join(f.directory, "quarantine"), 0o500);
        const reopened = storeAt(f.directory);
        await reopened.initialize();
        await expectHealthy(reopened);
        await expect(readFile(f.primary, "utf8")).resolves.toBe("{broken");
        if (withMetadata) {
          await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
        }
        await reopened.close();

        await chmod(path.join(f.directory, "quarantine"), 0o700);
        const retried = storeAt(f.directory);
        await retried.initialize();
        await expectHealthy(retried);
        await expect(readFile(f.quarantine, "utf8")).resolves.toBe("{broken");
        if (withMetadata) {
          await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe(
            f.metadataContent,
          );
        }
      },
    );

    it("needs no metadata rollback when the primary rename fails and metadata is read-only", async () => {
      const f = await fixture();
      await chmod(path.join(f.directory, "threads"), 0o500);
      await chmod(path.join(f.directory, "thread-metadata"), 0o500);
      const reopened = storeAt(f.directory);
      await reopened.initialize();
      await expectHealthy(reopened);
      await expect(readFile(f.primary, "utf8")).resolves.toBe("{broken");
      await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
      await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe(f.metadataContent);
      await expect(readFile(f.quarantine)).rejects.toMatchObject({ code: "ENOENT" });
      await reopened.close();

      // Retry at the same timestamp must not overwrite the existing metadata copy.
      const repeated = storeAt(f.directory);
      await repeated.initialize();
      await expectHealthy(repeated);
      await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
      await repeated.close();
      await chmod(path.join(f.directory, "threads"), 0o700);
      await chmod(path.join(f.directory, "thread-metadata"), 0o700);
      const retried = storeAt(f.directory, timestamp + 1);
      await retried.initialize();
      await expectHealthy(retried);
      await expect(
        readFile(
          path.join(
            f.directory,
            "quarantine",
            `${corruptId}.json.${timestamp + 1}.invalid.metadata`,
          ),
          "utf8",
        ),
      ).resolves.toBe(f.metadataContent);
    });

    it("retries source cleanup after the record moves without losing archived metadata", async () => {
      const f = await fixture();
      await chmod(path.join(f.directory, "thread-metadata"), 0o500);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reopened = storeAt(f.directory);
        await reopened.initialize();
        await expectHealthy(reopened);
        await expect(readFile(f.primary)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(f.quarantine, "utf8")).resolves.toBe("{broken");
        await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe(f.metadataContent);
        await expect(readFile(f.metadata, "utf8")).resolves.toBe(f.metadataContent);
        await reopened.close();
      }
      await chmod(path.join(f.directory, "thread-metadata"), 0o700);
      const retried = storeAt(f.directory);
      await retried.initialize();
      await expectHealthy(retried);
      await expect(readFile(f.metadata)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(`${f.quarantine}.metadata`, "utf8")).resolves.toBe(f.metadataContent);
    });
  },
);
