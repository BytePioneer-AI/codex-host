import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  MappingStore,
  storedThreadCoreV1Schema,
  storedThreadMetadataV1Schema,
  storedThreadRecordV1Schema,
} from "../src/index.js";

const directories: string[] = [];
const threadId = hostThreadIdSchema.parse("thread-future");
const record = {
  formatVersion: 1,
  revision: 3,
  hostThreadId: threadId,
  createRequestId: "create-future",
  harnessId: "pi",
  state: "ready",
  nativeSessionRef: {
    harnessId: "pi",
    nativeSessionId: "native-future",
    formatVersion: 1,
  },
  cwd: "/synthetic",
  title: "Future Thread",
  archived: false,
  transportModelId: "codexhost/pi-native",
  ephemeral: false,
  historyMode: "paginated",
  turnMappings: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const extensions = {
  futureMeasurements: { values: { inputTokens: 123 }, futureDetail: [null, "opaque"] },
  futureFlag: false,
};

async function seed(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-mapping-compatibility-"));
  directories.push(directory);
  await mkdir(path.join(directory, "threads"));
  await writeFile(path.join(directory, "threads", `${threadId}.json`), JSON.stringify(record));
  return directory;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Mapping Store forward compatibility", () => {
  it.each(["primary", "backup"])(
    "retains unknown Thread fields from the %s through migration, writes and restart",
    async (source) => {
      const directory = await seed();
      const recordFile = path.join(directory, "threads", `${threadId}.json`);
      const futureRecord = { ...record, ...extensions, projectId: "project-inline" };
      if (source === "backup") {
        await mkdir(path.join(directory, "backups"));
        await writeFile(
          path.join(directory, "backups", `${threadId}.json`),
          JSON.stringify(futureRecord),
        );
        await writeFile(recordFile, JSON.stringify({ ...futureRecord, revision: "invalid" }));
      } else {
        await writeFile(recordFile, JSON.stringify(futureRecord));
      }

      const first = new MappingStore({ directory });
      try {
        await first.initialize();
        await expect(first.getThread(threadId)).resolves.toMatchObject(futureRecord);
        await expect(readdir(path.join(directory, "quarantine"))).resolves.toEqual([]);
        await first.setTitle(threadId, "Updated Thread");
        await first.updateMetadata(threadId, { projectId: "project-updated" });
        for (const dir of ["threads", "backups"]) {
          const persisted = await readJson(path.join(directory, dir, `${threadId}.json`));
          expect(storedThreadCoreV1Schema.parse(persisted)).toMatchObject(extensions);
          expect(persisted).not.toHaveProperty("projectId");
        }
      } finally {
        await first.close();
      }

      const second = new MappingStore({ directory });
      try {
        await second.initialize();
        await expect(second.getThread(threadId)).resolves.toMatchObject({
          ...extensions,
          title: "Updated Thread",
          projectId: "project-updated",
        });
        await second.setArchived(threadId, true);
        expect(await readJson(recordFile)).toMatchObject({ ...extensions, archived: true });
      } finally {
        await second.close();
      }
    },
  );

  it("retains unknown metadata fields without using them or copying them into the Thread file", async () => {
    const directory = await seed();
    await mkdir(path.join(directory, "thread-metadata"));
    const metadataFile = path.join(directory, "thread-metadata", `${threadId}.json`);
    await writeFile(
      metadataFile,
      JSON.stringify({
        formatVersion: 1,
        hostThreadId: threadId,
        projectId: "project-a",
        ...extensions,
      }),
    );
    const first = new MappingStore({ directory });
    try {
      await first.initialize();
      await expect(first.getThread(threadId)).resolves.toMatchObject({ projectId: "project-a" });
      await expect(first.getThread(threadId)).resolves.not.toHaveProperty("futureMeasurements");
      await first.updateMetadata(threadId, { projectId: "project-b" });
      expect(await readJson(metadataFile)).toMatchObject({ ...extensions, projectId: "project-b" });
      await first.updateMetadata(threadId, { projectId: null });
      expect(await readJson(metadataFile)).toEqual({
        formatVersion: 1,
        hostThreadId: threadId,
        ...extensions,
      });
      expect(
        await readJson(path.join(directory, "threads", `${threadId}.json`)),
      ).not.toHaveProperty("futureMeasurements");
      await expect(readdir(path.join(directory, "quarantine"))).resolves.toEqual([]);
    } finally {
      await first.close();
    }

    const second = new MappingStore({ directory });
    try {
      await second.initialize();
      await expect(second.getThread(threadId)).resolves.not.toHaveProperty("projectId");
      await second.updateMetadata(threadId, { daybreakEnabled: true });
      expect(await readJson(metadataFile)).toMatchObject({ ...extensions, daybreakEnabled: true });
    } finally {
      await second.close();
    }
  });

  it.each([
    { revision: "invalid" },
    { formatVersion: 2 },
    { nativeSessionRef: undefined },
    { nativeSessionRef: { ...record.nativeSessionRef, harnessId: "claude-code" } },
  ])("still rejects invalid known Thread fields: %j", (invalid) => {
    expect(
      storedThreadRecordV1Schema.safeParse({ ...record, ...extensions, ...invalid }).success,
    ).toBe(false);
  });

  it("still rejects invalid known metadata fields", () => {
    expect(
      storedThreadMetadataV1Schema.safeParse({
        formatVersion: 1,
        hostThreadId: threadId,
        ...extensions,
        projectId: 42,
      }).success,
    ).toBe(false);
  });
});
