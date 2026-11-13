import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MappingStore } from "@codexhost/mapping-store";
import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
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
  for (const value of ["external", "subagent"]) {
    await store.createProvisional({
      hostThreadId: id(value),
      createRequestId: value,
      harnessId,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi",
      ephemeral: false,
      historyMode: "legacy",
      ...(value === "subagent"
        ? { subagent: { parentHostThreadId: id("external"), nativeSubagentId: "native-sub" } }
        : {}),
    });
    await store.commitReady({
      hostThreadId: id(value),
      nativeSessionRef: nativeSessionRefSchema.parse({
        harnessId,
        nativeSessionId: value,
        locator: { sessionFile: `/synthetic/${value}` },
        formatVersion: 1,
      }),
    });
  }
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
  const official = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const threadId = params.threadId;
    return ["a", "b", "c", "native-subagent", "client-child"].includes(String(threadId))
      ? {
          result: {
            thread: {
              id: String(threadId),
              source:
                threadId === "native-subagent" ? { subAgent: { thread_spawn: {} } } : "vscode",
            },
          },
        }
      : { error: { code: -1, message: "unknown" } };
  });
  const tree = new ThreadTree(new ExternalThreadRepository(store), official);
  return { store, tree, official, id };
}

it("merges historical multilevel delegation, honors manual placement and durable top level without altering --parent results", async () => {
  const { store, tree, id } = await fixture();
  const delegatedToB = await store.listDelegations(id("b"));
  expect(await tree.read()).toEqual({ parents: { b: "a", external: "b" } });
  expect(await tree.place("b", "c")).toEqual({ parents: { b: "c", external: "b" } });
  expect(await tree.place("external", "a")).toEqual({ parents: { b: "c", external: "a" } });
  expect(await tree.place("external", null)).toEqual({ parents: { b: "c" } });
  expect(
    await new ThreadTree(new ExternalThreadRepository(store), async () => ({})).read(),
  ).toEqual({ parents: { b: "c" } });
  expect(await store.listDelegations(id("b"))).toEqual(delegatedToB);
  expect(await tree.place("c", "external")).toEqual({ parents: { b: "c", c: "external" } });
  // Direct native archive is not handled by the display tree module.
  const archived = vi.fn();
  await tree.handle({ id: 1, method: "codexhost/thread/tree/read", params: {} }, archived);
  expect(archived).not.toHaveBeenCalled();
});

it.each([
  ["a", "a"],
  ["a", "external"],
  ["subagent", "a"],
  ["a", "subagent"],
  ["native-subagent", "a"],
  ["a", "native-subagent"],
  ["unknown", "a"],
  ["a", "unknown"],
])("rejects invalid placement %s -> %s without writing", async (threadId, parentThreadId) => {
  const { store, tree } = await fixture();
  const changed = vi.fn();
  const result = await tree.handle(
    { id: 1, method: "codexhost/thread/tree/place", params: { threadId, parentThreadId } },
    changed,
  );
  expect(result).toMatchObject({ error: { code: -32602, data: { code: "INVALID_ARGUMENT" } } });
  expect(await store.listThreadTreePlacements()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
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
  expect(await tree.place("client-child", "a")).toEqual({
    parents: { b: "a", external: "b", "client-child": "a" },
  });
  expect(await store.listDelegations(id("client:automation"))).toEqual([
    expect.objectContaining({ childHostThreadId: "client-child" }),
  ]);
});

it.each([
  { method: "codexhost/thread/tree/read", params: { extra: true } },
  { method: "codexhost/thread/tree/place", params: { threadId: "a" } },
  { method: "codexhost/thread/tree/place", params: { threadId: "a", parentThreadId: 42 } },
])(
  "rejects invalid parameters without changing placements: $method",
  async ({ method, params }) => {
    const { tree, store } = await fixture();
    const changed = vi.fn();
    expect(await tree.handle({ id: 1, method, params }, changed)).toMatchObject({
      error: { data: { code: "INVALID_ARGUMENT" } },
    });
    expect(await store.listThreadTreePlacements()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  },
);

it("serializes competing placement checks and publishes only successful changes", async () => {
  const { tree } = await fixture();
  const changed = vi.fn();
  const first = tree.handle(
    {
      id: 1,
      method: "codexhost/thread/tree/place",
      params: { threadId: "a", parentThreadId: "c" },
    },
    changed,
  );
  const second = tree.handle(
    {
      id: 2,
      method: "codexhost/thread/tree/place",
      params: { threadId: "c", parentThreadId: "a" },
    },
    changed,
  );
  expect(await first).toMatchObject({ result: { parents: { a: "c" } } });
  expect(await second).toMatchObject({ error: { data: { code: "INVALID_ARGUMENT" } } });
  expect(changed).toHaveBeenCalledExactlyOnceWith("a");
});
