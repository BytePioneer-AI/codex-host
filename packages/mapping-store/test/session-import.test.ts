import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore, type CreateProvisionalThreadInput } from "../src/index.js";

const directories: string[] = [];
const stores: MappingStore[] = [];
const harnessId = harnessIdSchema.parse("pi");
const sourceRef = nativeSessionRefSchema.parse({
  harnessId,
  nativeSessionId: "import-source",
  formatVersion: 1,
});
const forkRef = nativeSessionRefSchema.parse({ ...sourceRef, nativeSessionId: "import-fork" });
const input: CreateProvisionalThreadInput = {
  hostThreadId: hostThreadIdSchema.parse("imported-thread"),
  createRequestId: "session-import-request",
  harnessId,
  importSourceRef: sourceRef,
  cwd: "/synthetic",
  title: "Imported Session",
  transportModelId: "codexhost/pi",
  ephemeral: false,
  historyMode: "paginated",
};

async function openStore(directory: string): Promise<MappingStore> {
  const store = new MappingStore({ directory });
  stores.push(store);
  await store.initialize();
  return store;
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mapping-session-import-"));
  directories.push(directory);
  return { directory, store: await openStore(directory) };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Session import identity", () => {
  it.each(["primary", "backup"])(
    "retains an unconfirmed import from its %s while cleaning ordinary provisional Threads",
    async (source) => {
      const { directory, store } = await fixture();
      await store.createProvisional(input);
      await store.setTitle(input.hostThreadId, "Import pending");
      const ordinaryId = hostThreadIdSchema.parse("ordinary-provisional");
      await store.createProvisional({
        hostThreadId: ordinaryId,
        createRequestId: "ordinary-create",
        harnessId,
        cwd: input.cwd,
        transportModelId: input.transportModelId,
        ephemeral: false,
        historyMode: "paginated",
      });
      await store.close();
      if (source === "backup")
        await writeFile(path.join(directory, "threads", `${input.hostThreadId}.json`), "{broken");

      const reopened = await openStore(directory);
      const pending = await reopened.getThreadByCreateRequest(input.createRequestId);
      expect(pending).toMatchObject({
        hostThreadId: input.hostThreadId,
        state: "creating",
        importSourceRef: sourceRef,
      });
      expect(pending).not.toHaveProperty("nativeSessionRef");
      expect(await reopened.getThread(ordinaryId)).toBeNull();
      expect(await reopened.getThreadByCreateRequest("ordinary-create")).toBeNull();
      await expect(
        readFile(path.join(directory, "threads", `${ordinaryId}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await reopened.createProvisional({
          ...input,
          hostThreadId: hostThreadIdSchema.parse("duplicate-import"),
        }),
      ).toEqual(pending);
      expect(await reopened.listThreads()).toHaveLength(1);
    },
  );

  it.each([sourceRef, forkRef])(
    "retains the import source independently of destination $nativeSessionId through backup recovery",
    async (nativeSessionRef) => {
      const { directory, store } = await fixture();
      await store.createProvisional(input);
      await store.commitReady({ hostThreadId: input.hostThreadId, nativeSessionRef });
      await store.setTitle(input.hostThreadId, "Renamed import");
      await store.updateMetadata(input.hostThreadId, { projectId: "project" });
      for (const name of ["threads", "backups"]) {
        const persisted = JSON.parse(
          await readFile(path.join(directory, name, `${input.hostThreadId}.json`), "utf8"),
        );
        expect(persisted).toMatchObject({
          state: "ready",
          nativeSessionRef,
          importSourceRef: sourceRef,
        });
      }
      const metadata = JSON.parse(
        await readFile(
          path.join(directory, "thread-metadata", `${input.hostThreadId}.json`),
          "utf8",
        ),
      );
      expect(metadata).not.toHaveProperty("importSourceRef");
      await store.close();
      await writeFile(path.join(directory, "threads", `${input.hostThreadId}.json`), "{broken");

      const reopened = await openStore(directory);
      expect(await reopened.getThreadByCreateRequest(input.createRequestId)).toMatchObject({
        hostThreadId: input.hostThreadId,
        state: "ready",
        nativeSessionRef,
        importSourceRef: sourceRef,
        projectId: "project",
      });
      expect(
        await reopened.createProvisional({
          ...input,
          hostThreadId: hostThreadIdSchema.parse("duplicate-import"),
        }),
      ).toMatchObject({ hostThreadId: input.hostThreadId, state: "ready", nativeSessionRef });
      expect(await reopened.listThreads()).toHaveLength(1);
    },
  );

  it.each([
    {
      name: "a different Harness",
      change: {
        importSourceRef: nativeSessionRefSchema.parse({ ...sourceRef, harnessId: "claude-code" }),
      },
    },
    {
      name: "a Subagent Thread",
      change: {
        subagent: {
          parentHostThreadId: hostThreadIdSchema.parse("parent"),
          nativeSubagentId: "child",
        },
      },
    },
  ])("rejects an import source for $name before persisting it", async ({ change }) => {
    const { store } = await fixture();
    await expect(store.createProvisional({ ...input, ...change })).rejects.toThrow();
    expect(await store.listThreads()).toEqual([]);
    expect(await store.getThreadByCreateRequest(input.createRequestId)).toBeNull();
  });
});
