import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore, type StoredSectionPlacementV1 } from "../src/index.js";

const temporaryDirectories: string[] = [];
const harnessId = harnessIdSchema.parse("pi");

async function openStore(directory: string, instanceId: string): Promise<MappingStore> {
  const store = new MappingStore({ directory, instanceId });
  await store.initialize();
  return store;
}

async function createThread(store: MappingStore, value: string) {
  const hostThreadId = hostThreadIdSchema.parse(value);
  await store.createProvisional({
    hostThreadId,
    createRequestId: `create-${value}`,
    harnessId,
    cwd: "/synthetic",
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
  });
  // Provisional records do not survive restart; placements belong to ready Threads.
  await store.commitReady({
    hostThreadId,
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: `native-${value}`,
      locator: { sessionFile: `/synthetic/${value}.jsonl` },
      formatVersion: 1,
    }) as NativeSessionRef,
  });
  return hostThreadId;
}

function placement(hostThreadId: string, beforeThreadId: string | null): StoredSectionPlacementV1 {
  return {
    hostThreadId: hostThreadIdSchema.parse(hostThreadId),
    section: { id: "section-pinned", name: "Pinned", appearance: null },
    enteredAt: "2026-09-30T00:00:00.000Z",
    beforeThreadId,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Mapping Store section placements", () => {
  it("persists placements beside Thread records without changing them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-sections-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");
    const a = await createThread(first, "thread-a");
    const b = await createThread(first, "thread-b");
    const before = await first.getThread(a);
    await first.replaceSectionPlacements([placement(a, b), placement(b, null)]);
    // Presentation state must not bump Thread revision or recency.
    await expect(first.getThread(a)).resolves.toEqual(before);
    await first.close();

    const record = JSON.parse(await readFile(path.join(directory, "threads", `${a}.json`), "utf8"));
    expect(record).not.toHaveProperty("section");

    const second = await openStore(directory, "second");
    await expect(second.listSectionPlacements()).resolves.toEqual([
      placement(a, b),
      placement(b, null),
    ]);
    await second.removeThread(b);
    // A was anchored to the removed B, so it inherits B's anchor (last in the section).
    await expect(second.listSectionPlacements()).resolves.toEqual([placement(a, null)]);
    await second.close();
  });

  it("keeps order when an anchoring Thread is removed", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-sections-"));
    temporaryDirectories.push(directory);
    const store = await openStore(directory, "only");
    const a = await createThread(store, "thread-a");
    const b = await createThread(store, "thread-b");
    const c = await createThread(store, "thread-c");
    const d = await createThread(store, "thread-d");
    // Order [a, b, d, c, official-o]: a -> b -> c -> official-o, and d -> c.
    await store.replaceSectionPlacements([
      placement(a, b),
      placement(b, c),
      placement(c, "official-o"),
      placement(d, c),
    ]);
    await store.removeThread(b);
    await store.removeThread(c);
    // a follows b -> c -> official-o; d follows c -> official-o.
    await expect(store.listSectionPlacements()).resolves.toEqual([
      placement(a, "official-o"),
      placement(d, "official-o"),
    ]);
    await store.close();
  });

  it("stops at a cycle of removed anchors", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-sections-"));
    temporaryDirectories.push(directory);
    const store = await openStore(directory, "only");
    const a = await createThread(store, "thread-a");
    const b = await createThread(store, "thread-b");
    const c = await createThread(store, "thread-c");
    await store.replaceSectionPlacements([placement(a, b), placement(b, c), placement(c, b)]);
    await store.removeThread(b);
    await store.removeThread(c);
    await expect(store.listSectionPlacements()).resolves.toEqual([placement(a, null)]);
    await store.close();
  });

  it("drops placements of unknown Threads and rejects duplicates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-sections-"));
    temporaryDirectories.push(directory);
    const store = await openStore(directory, "only");
    const a = await createThread(store, "thread-a");
    await expect(
      store.replaceSectionPlacements([placement(a, null), placement("thread-unknown", null)]),
    ).resolves.toEqual([placement(a, null)]);
    await expect(
      store.replaceSectionPlacements([placement(a, null), placement(a, null)]),
    ).rejects.toMatchObject({ code: "IO_ERROR" });
    await expect(store.listSectionPlacements()).resolves.toEqual([placement(a, null)]);
    await store.close();
  });

  it("quarantines an invalid placement file without blocking Thread access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-sections-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");
    const a = await createThread(first, "thread-a");
    await first.close();
    await writeFile(path.join(directory, "sections", "placements.json"), "{not json");

    const second = await openStore(directory, "second");
    await expect(second.getThread(a)).resolves.toMatchObject({ hostThreadId: a });
    await expect(second.listSectionPlacements()).resolves.toEqual([]);
    expect(
      (await readdir(path.join(directory, "quarantine"))).some((name) =>
        name.startsWith("section-placements.json."),
      ),
    ).toBe(true);
    await second.close();
  });
});
