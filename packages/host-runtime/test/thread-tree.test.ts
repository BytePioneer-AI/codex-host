import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ThreadTree } from "../src/thread-tree.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "host-tree-"));
  const store = new MappingStore({ directory });
  await store.initialize();
  cleanup.push(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const harnessId = harnessIdSchema.parse("pi");
  const id = (value: string) => hostThreadIdSchema.parse(value);
  for (const [parent, child] of [
    ["a", "b"],
    ["b", "external"],
  ] as const) {
    await store.createDelegation({
      delegationId: id(`delegation-${child}`),
      childHostThreadId: id(child),
      parentHostThreadId: id(parent),
      sourceHarnessId: harnessId,
      targetHarnessId: harnessId,
      taskDigest: "b".repeat(64),
    });
  }
  const pins = new Set<string>();
  const tree = new ThreadTree(new ExternalThreadRepository(store), async () => [...pins]);
  return { store, tree, id, pins };
}

it("reads historical multilevel delegation without altering --parent results", async () => {
  const { store, tree, id } = await fixture();
  const delegatedToB = await store.listDelegations(id("b"));
  expect(await tree.read()).toEqual({ parents: { b: "a", external: "b" } });
  expect(await new ThreadTree(new ExternalThreadRepository(store), async () => []).read()).toEqual({
    parents: { b: "a", external: "b" },
  });
  expect(await store.listDelegations(id("b"))).toEqual(delegatedToB);
  expect(
    await tree.handle({ id: 1, method: "codexhost/thread/tree/read", params: {} }),
  ).toMatchObject({
    result: { parents: { b: "a", external: "b" } },
  });
});

it("keeps external client origins out of display parents without changing delegation records", async () => {
  const { store, tree, id } = await fixture();
  await store.createDelegation({
    delegationId: id("client-delegation"),
    parentHostThreadId: id("client:automation"),
    childHostThreadId: id("client-child"),
    sourceHarnessId: harnessIdSchema.parse("codex"),
    targetHarnessId: harnessIdSchema.parse("codex"),
    taskDigest: "c".repeat(64),
  });
  expect(await tree.read()).toEqual({ parents: { b: "a", external: "b" } });
  expect(await store.listDelegations(id("client:automation"))).toEqual([
    expect.objectContaining({ childHostThreadId: "client-child" }),
  ]);
});

it("promotes a pinned child with its descendants and restores delegation on unpin", async () => {
  const { tree, pins, store, id } = await fixture();
  const delegations = await store.listDelegations(id("a"));
  pins.add("b");
  expect(await tree.read()).toEqual({ parents: { external: "b" } });
  pins.add("external");
  expect(await tree.read()).toEqual({ parents: {} });
  pins.delete("b");
  expect(await tree.read()).toEqual({ parents: { b: "a" } });
  pins.clear();
  expect(await tree.read()).toEqual({ parents: { b: "a", external: "b" } });
  expect(await store.listDelegations(id("a"))).toEqual(delegations);
});

it("rejects invalid read parameters", async () => {
  const { tree } = await fixture();
  expect(
    await tree.handle({ id: 1, method: "codexhost/thread/tree/read", params: { extra: true } }),
  ).toMatchObject({ error: { data: { code: "INVALID_ARGUMENT" } } });
});
