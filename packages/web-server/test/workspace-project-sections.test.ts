import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { Workspaces, nativeProjectWorkspaceId, type ThreadSectionView } from "../src/workspaces.ts";

const sections = ["a", "b", "c"].map((id) => ({ id, name: id, threadIds: [id + "-thread"] }));
const projects = ["one", "two"].map((id) => ({ id, name: "Same", rootPaths: [] }));
const one = nativeProjectWorkspaceId("one");
const two = nativeProjectWorkspaceId("two");

function setup(root: string) {
  const workspaces = new Workspaces(new DataDir(root), root);
  workspaces.syncNativeProjects(projects, new Map([["conversation", "one"]]), {}, new Map());
  const rpc = new RpcRegistry();
  let follow!: StreamHandler;
  class Streams extends StreamRegistry {
    override register(name: string, callback: StreamHandler) {
      super.register(name, callback);
      if (name === "workspace/follow") follow = callback;
    }
  }
  workspaces.register(rpc, new Streams());
  return {
    workspaces,
    refresh: (placement: Record<string, string[]>, visible = sections) =>
      workspaces.setReferenceThreadSections(visible, projects, placement),
    move: (request: object) =>
      rpc.dispatch("workspace/moveWorkspaceToSection", { args: { request } }),
    follow: async () => {
      const snapshots: ThreadSectionView[][] = [];
      await follow(
        {},
        {
          id: "fixture",
          closed: false,
          end() {},
          onClose() {},
          fail(code, message) {
            throw new Error(code + " " + message);
          },
          push(frame) {
            const msg = frame as {
              type: string;
              value?: { threadSections: ThreadSectionView[] };
              threadSections?: ThreadSectionView[];
            };
            const sections = msg.value?.threadSections ?? msg.threadSections;
            if (sections) snapshots.push(sections);
          },
        },
      );
      return snapshots;
    },
  };
}

it("keeps a local project move across refresh and reconnect until its official membership changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "project-sections-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = setup(root);
  first.refresh({ a: ["one"], b: ["two"] });
  const frames = await first.follow();
  assert.deepEqual(await first.move({ workspaceId: one, sectionId: "b" }), {
    ok: true,
    value: { sectionId: "b" },
  });
  const moved = [sections[0], { ...sections[1], workspaceIds: [two, one] }, sections[2]];
  assert.deepEqual(frames.at(-1), moved);
  assert.deepEqual(first.workspaces.get(one)?.sessionIds, ["conversation"]);
  await first.move({ workspaceId: one, sectionId: "b" });
  first.refresh({ a: ["one"], b: ["two"] });
  assert.equal(frames.length, 2);
  const restarted = setup(root);
  restarted.refresh({ a: ["one"], b: ["two"] });
  const next = await restarted.follow();
  assert.deepEqual(next[0], moved);
  await restarted.move({ workspaceId: one, sectionId: null });
  assert.equal(
    next.at(-1)?.some((s) => s.workspaceIds?.includes(one)),
    false,
  );
  restarted.refresh({ c: ["one", "two"] });
  assert.deepEqual(next.at(-1)?.[2]?.workspaceIds, [one, two]);
  await restarted.move({ workspaceId: one, sectionId: "b" });
  restarted.refresh({ c: ["one", "two"] }, [sections[0]!, sections[2]!]);
  assert.deepEqual(next.at(-1)?.[1]?.workspaceIds, [one, two]);
  restarted.refresh({ c: ["one", "two"] });
  assert.deepEqual(next.at(-1)?.[2]?.workspaceIds, [one, two]);
});

it("rejects missing destinations and non-native workspaces, and never publishes an unsuccessful write", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "project-section-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { refresh, follow, move, workspaces } = setup(root);
  refresh({ a: ["one"] });
  const frames = await follow();
  for (const request of [
    { workspaceId: one },
    { sectionId: "b" },
    { workspaceId: one, sectionId: "missing" },
    { workspaceId: "remote", sectionId: "b" },
  ])
    assert.equal((await move(request)).ok, false);
  const file = join(root, "workspaces.json");
  mkdirSync(file);
  assert.equal((await move({ workspaceId: one, sectionId: "b" })).ok, false);
  assert.equal(frames.length, 1);
  assert.deepEqual((await follow())[0], frames[0]);
  rmSync(file, { recursive: true });
  assert.equal((await move({ workspaceId: one, sectionId: "b" })).ok, true);
  assert.deepEqual(workspaces.get(one)?.sessionIds, ["conversation"]);
  await move({ workspaceId: two, sectionId: "c" });
  await move({ workspaceId: one, sectionId: "c" });
  assert.deepEqual(frames.at(-1)?.[2]?.workspaceIds, [two, one]);
});

it("keeps the last confirmed project section through partial Desktop reads", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "project-section-partial-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = setup(root);
  original.refresh({ a: ["one", "two"] });
  await original.move({ workspaceId: one, sectionId: "b" });
  const restarted = setup(root);
  const frames = await restarted.follow();
  const ownerOf = (id: string) => frames.at(-1)?.find((s) => s.workspaceIds?.includes(id))?.id;
  // The section list still exists. The local renderer's project list for A is unavailable.
  restarted.refresh({ b: [], c: [] });
  assert.equal(ownerOf(one), "b");
  await restarted.move({ workspaceId: one, sectionId: "c" });
  restarted.refresh({ a: ["one", "two"] });
  assert.equal(ownerOf(one), "c");
  restarted.refresh({ a: [] });
  assert.equal(ownerOf(one), undefined);
  // A positive placement in B supersedes A, even while A's own list is unavailable.
  restarted.refresh({ a: ["one", "two"] });
  await restarted.move({ workspaceId: one, sectionId: "c" });
  restarted.refresh({ b: ["one"] });
  assert.equal(ownerOf(one), "b");
  assert.equal(ownerOf(two), "a");
  await restarted.move({ workspaceId: two, sectionId: "c" });
  restarted.refresh({ b: ["one"] }, sections.slice(1));
  assert.equal(ownerOf(two), undefined);
});
