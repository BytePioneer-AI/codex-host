import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { MappingStore } from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "thread-tree-store-"));
  directories.push(directory);
  const store = new MappingStore({ directory });
  await store.initialize();
  const child = hostThreadIdSchema.parse("child");
  const parent = hostThreadIdSchema.parse("parent");
  const harnessId = harnessIdSchema.parse("pi");
  await store.createProvisional({
    hostThreadId: child,
    createRequestId: "create-child",
    harnessId,
    cwd: "/synthetic",
    transportModelId: "codexhost/pi",
    ephemeral: false,
    historyMode: "legacy",
  });
  await store.commitReady({
    hostThreadId: child,
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId,
      nativeSessionId: "native-child",
      locator: {},
      formatVersion: 1,
    }),
  });
  await store.createDelegation({
    delegationId: child,
    childHostThreadId: child,
    parentHostThreadId: parent,
    sourceHarnessId: harnessId,
    targetHarnessId: harnessId,
    taskDigest: "a".repeat(64),
  });
  return { store, directory, child, parent };
}

it("restores official and external placements, including explicit top level, without changing records", async () => {
  const { store, directory, child, parent } = await fixture();
  const before = await store.getThread(child);
  const delegations = await store.listDelegations();
  await store.setThreadTreePlacement(child, null);
  await store.setThreadTreePlacement("official", parent);
  expect(await store.getThread(child)).toEqual(before);
  expect(await store.listDelegations()).toEqual(delegations);
  await store.close();
  const reopened = new MappingStore({ directory });
  await reopened.initialize();
  expect(await reopened.listThreadTreePlacements()).toEqual([
    expect.objectContaining({ hostThreadId: child, parentThreadId: null }),
    expect.objectContaining({ hostThreadId: "official", parentThreadId: parent }),
  ]);
  await reopened.setThreadTreePlacement("official", null);
  expect(await reopened.listThreadTreePlacements()).toHaveLength(1);
  await reopened.close();
  const again = new MappingStore({ directory });
  await again.initialize();
  expect(await again.listThreadTreePlacements()).toEqual([
    expect.objectContaining({ hostThreadId: child, parentThreadId: null }),
  ]);
  expect(await again.listDelegations()).toEqual(delegations);
  await again.close();
  expect(
    JSON.parse(await readFile(join(directory, "thread-tree-placements.json"), "utf8"))
      .formatVersion,
  ).toBe(1);
  expect((await readdir(directory)).some((name) => name.includes(".tmp-"))).toBe(false);
});

it.each(["{broken", JSON.stringify({ formatVersion: 2, placements: [] })])(
  "ignores an unreadable placement file and preserves it: %s",
  async (text) => {
    const { store, directory, child } = await fixture();
    const before = await store.getThread(child);
    const delegations = await store.listDelegations();
    await store.close();
    const file = join(directory, "thread-tree-placements.json");
    await writeFile(file, text);
    const reopened = new MappingStore({ directory });
    await reopened.initialize();
    expect(await reopened.listThreadTreePlacements()).toEqual([]);
    expect(await reopened.getThread(child)).toEqual(before);
    expect(await reopened.listDelegations()).toEqual(delegations);
    expect(await readFile(file, "utf8")).toBe(text);
    expect(await readdir(join(directory, "quarantine"))).toEqual([]);
    await reopened.close();
  },
);
