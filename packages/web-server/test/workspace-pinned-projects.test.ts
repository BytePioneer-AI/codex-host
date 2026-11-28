import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DataDir } from "../src/store.ts";
import { RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { Workspaces, nativeProjectWorkspaceId } from "../src/workspaces.ts";

const projects = [
  { id: "atlas", name: "Atlas", rootPaths: ["/tmp/atlas"] },
  { id: "boreal", name: "Boreal", rootPaths: ["/tmp/boreal"] },
  { id: "compass", name: "Compass", rootPaths: ["/tmp/compass"] },
];
const atlas = nativeProjectWorkspaceId("atlas");
const boreal = nativeProjectWorkspaceId("boreal");
const compass = nativeProjectWorkspaceId("compass");

function readStoredOverrides(root: string): Record<string, unknown> | undefined {
  const raw = JSON.parse(readFileSync(join(root, "workspaces.json"), "utf8")) as {
    pinnedWorkspaceOverrides?: Record<string, unknown>;
  };
  return raw.pinnedWorkspaceOverrides;
}

function setupNative(root: string, activeProjects = projects) {
  const workspaces = new Workspaces(new DataDir(root), root);
  workspaces.syncNativeProjects(activeProjects, new Map(), {}, new Map());
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
    refresh: (pinnedProjects?: readonly string[], nextProjects = activeProjects) => {
      workspaces.syncNativeProjects(nextProjects, new Map(), {}, new Map());
      workspaces.setReferencePinnedProjects(nextProjects, pinnedProjects);
    },
    setPinned: (request: object) =>
      rpc.dispatch("workspace/setWorkspacePinned", { args: { request } }),
    follow: async () => {
      const frames: string[][] = [];
      await follow(
        {},
        {
          id: "follower",
          closed: false,
          end() {},
          onClose() {},
          fail(code, message) {
            throw new Error(code + " " + message);
          },
          push(frame) {
            const msg = frame as {
              type: string;
              value?: { pinnedWorkspaceIds?: string[] };
              pinnedWorkspaceIds?: string[];
            };
            const pinned =
              msg.type === "baseline"
                ? msg.value?.pinnedWorkspaceIds
                : msg.type === "pinnedWorkspaces"
                  ? msg.pinnedWorkspaceIds
                  : undefined;
            if (pinned !== undefined) frames.push(pinned);
          },
        },
      );
      return frames;
    },
  };
}

it("syncs Desktop pinned-project-ids read-only and preserves Desktop order", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { refresh, follow } = setupNative(root);
  const frames = await follow();
  assert.deepEqual(frames, [[]]);

  refresh(["compass", "atlas", "unknown-id", "compass"]);
  assert.deepEqual(frames.at(-1), [compass, atlas]);

  // Same snapshot produces no duplicate broadcast.
  refresh(["compass", "atlas"]);
  assert.equal(frames.length, 2);

  // Desktop reordering updates Web projection cleanly.
  refresh(["atlas", "compass"]);
  assert.deepEqual(frames.at(-1), [atlas, compass]);
});

it("persists Web pin/unpin across restarts, broadcasts to multiple clients, and places newest Web pins first", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-persist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = setupNative(root);
  first.refresh(["atlas"]);
  const clientA = await first.follow();
  const clientB = await first.follow();
  assert.deepEqual(clientA, [[atlas]]);
  assert.deepEqual(clientB, [[atlas]]);

  assert.deepEqual(await first.setPinned({ workspaceId: boreal, pinned: true }), {
    ok: true,
    value: { pinnedWorkspaceIds: [boreal, atlas] },
  });
  assert.deepEqual(clientA.at(-1), [boreal, atlas]);
  assert.deepEqual(clientB.at(-1), [boreal, atlas]);

  // Pinning a second workspace places the newest Web pin ahead of earlier ones.
  assert.deepEqual(await first.setPinned({ workspaceId: compass, pinned: true }), {
    ok: true,
    value: { pinnedWorkspaceIds: [compass, boreal, atlas] },
  });
  assert.deepEqual(clientA.at(-1), [compass, boreal, atlas]);

  // Idempotent repeat does not broadcast again.
  const countBefore = clientA.length;
  assert.deepEqual(await first.setPinned({ workspaceId: compass, pinned: true }), {
    ok: true,
    value: { pinnedWorkspaceIds: [compass, boreal, atlas] },
  });
  assert.equal(clientA.length, countBefore);

  // Restart recovers the persisted overrides and order.
  const restarted = setupNative(root);
  restarted.refresh(["atlas"]);
  const reconnected = await restarted.follow();
  assert.deepEqual(reconnected[0], [compass, boreal, atlas]);

  // Unpinning compass removes its override.
  assert.deepEqual(await restarted.setPinned({ workspaceId: compass, pinned: false }), {
    ok: true,
    value: { pinnedWorkspaceIds: [boreal, atlas] },
  });
  assert.deepEqual(Object.keys(readStoredOverrides(root) ?? {}), [boreal]);
});

it("clears Web pin override automatically when Desktop also pins the same workspace, without duplication, then syncs Desktop unpin", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-both-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { refresh, follow, setPinned } = setupNative(root);
  refresh(["atlas"]);
  const frames = await follow();
  assert.deepEqual(frames.at(-1), [atlas]);

  // Web pins Boreal while Desktop has not pinned it.
  await setPinned({ workspaceId: boreal, pinned: true });
  assert.deepEqual(frames.at(-1), [boreal, atlas]);
  assert.ok(readStoredOverrides(root)?.[boreal]);

  // Desktop now also pins Boreal -> override is auto-cleared and Boreal appears once (official order).
  refresh(["atlas", "boreal"]);
  assert.deepEqual(frames.at(-1), [atlas, boreal]);
  assert.equal(readStoredOverrides(root), undefined);

  // Subsequently Desktop unpins Boreal -> Web naturally follows and unpins Boreal.
  refresh(["atlas"]);
  assert.deepEqual(frames.at(-1), [atlas]);
  assert.equal(readStoredOverrides(root), undefined);
});

it("clears Web unpin override automatically once Desktop also unpins the workspace", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-both-unpin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { refresh, follow, setPinned } = setupNative(root);
  refresh(["atlas", "boreal"]);
  const frames = await follow();
  assert.deepEqual(frames.at(-1), [atlas, boreal]);

  // Web unpins Atlas (anchored to official: true).
  await setPinned({ workspaceId: atlas, pinned: false });
  assert.deepEqual(frames.at(-1), [boreal]);
  assert.deepEqual(readStoredOverrides(root)?.[atlas], { official: true, target: false });

  // Refresh while Desktop still pins Atlas keeps Atlas unpinned.
  refresh(["atlas", "boreal"]);
  assert.deepEqual(frames.at(-1), [boreal]);
  assert.deepEqual(readStoredOverrides(root)?.[atlas], { official: true, target: false });

  // Desktop now unpins Atlas -> override is cleared automatically.
  refresh(["boreal"]);
  assert.deepEqual(frames.at(-1), [boreal]);
  assert.equal(readStoredOverrides(root), undefined);

  // If Desktop later pins Atlas again, Web naturally follows and shows Atlas pinned.
  refresh(["atlas", "boreal"]);
  assert.deepEqual(frames.at(-1), [atlas, boreal]);
});

it("supports pure Web workspaces and remote workspaces, and cleans up overrides when deleted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-web-and-delete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wsDir = join(root, "local-dir");
  mkdirSync(wsDir);
  const workspaces = new Workspaces(new DataDir(root), root);
  const rpc = new RpcRegistry();
  const streams = new StreamRegistry();
  workspaces.register(rpc, streams);

  const created = workspaces.create(wsDir).workspace;
  const remoteId = `remote-workspace:${Buffer.from(JSON.stringify(["peer-a", "proj-1"])).toString("base64url")}`;
  workspaces.setRemoteGroups([
    {
      workspaceId: remoteId,
      path: "/remote/proj-1",
      title: "Remote Proj",
      sessionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      remote: { hostId: "peer-a", displayName: "Peer A", state: "connected" },
    },
  ]);

  assert.deepEqual(
    await rpc.dispatch("workspace/setWorkspacePinned", {
      args: { request: { workspaceId: created.workspaceId, pinned: true } },
    }),
    { ok: true, value: { pinnedWorkspaceIds: [created.workspaceId] } },
  );
  assert.deepEqual(
    await rpc.dispatch("workspace/setWorkspacePinned", {
      args: { request: { workspaceId: remoteId, pinned: true } },
    }),
    { ok: true, value: { pinnedWorkspaceIds: [remoteId, created.workspaceId] } },
  );

  // Deleting the pure Web workspace cleans its override atomically.
  assert.deepEqual(
    await rpc.dispatch("workspace/delete", {
      args: { request: { workspaceId: created.workspaceId } },
    }),
    { ok: true, value: { deleted: true } },
  );
  assert.deepEqual(workspaces.pinnedWorkspaceIds(), [remoteId]);
  assert.deepEqual(Object.keys(readStoredOverrides(root) ?? {}), [remoteId]);

  // Permanently removing the remote host cleans its pin override too.
  workspaces.removeRemoteHostOrder("peer-a");
  assert.equal(readStoredOverrides(root), undefined);
  assert.deepEqual(workspaces.pinnedWorkspaceIds(), []);
});

it("rejects invalid or missing workspaceIds and rolls back atomically on disk write failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pinned-projects-errors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { refresh, follow, setPinned } = setupNative(root);
  refresh(["atlas"]);
  const frames = await follow();

  for (const request of [
    {},
    { workspaceId: "", pinned: true },
    { workspaceId: atlas },
    { workspaceId: atlas, pinned: "yes" },
    { workspaceId: "codex-project:missing", pinned: true },
  ]) {
    const reply = await setPinned(request);
    assert.equal(reply.ok, false);
  }
  assert.equal(frames.length, 1);

  // Simulate write failure by replacing workspaces.json with a directory.
  const file = join(root, "workspaces.json");
  mkdirSync(file);
  const failed = await setPinned({ workspaceId: boreal, pinned: true });
  assert.equal(failed.ok, false);
  assert.equal(frames.length, 1);
  assert.deepEqual((await follow())[0], [atlas]);

  // Removing the obstruction allows subsequent writes to succeed cleanly.
  rmSync(file, { recursive: true });
  const recovered = await setPinned({ workspaceId: boreal, pinned: true });
  assert.deepEqual(recovered, { ok: true, value: { pinnedWorkspaceIds: [boreal, atlas] } });
  assert.deepEqual(frames.at(-1), [boreal, atlas]);
});
