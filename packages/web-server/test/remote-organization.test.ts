import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { RpcRegistry, StreamRegistry, type StreamHandler } from "../src/transport.ts";
import { LocalSessionOrganization } from "@codexhost/session-runtime";

async function invoke(
  rpc: RpcRegistry,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await rpc.dispatch(method, { args });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it("routes confirmed local organization to Host and leaves the legacy mixed file untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-organization-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = new DataDir(root);
  data.writeJson("workspaces.json", {
    items: [],
    pinnedSessionIds: ["legacy-other"],
    archivedSessionIds: [],
  });
  const original = readFileSync(data.path("workspaces.json"));
  const owned = new LocalSessionOrganization(
    new DataDir(join(root, "host")),
    (id) => id === "local",
  );
  const workspace = owned.create(root).workspace;
  owned.attachSession("local", workspace.workspaceId, root);
  const view = new Workspaces(data, root, true);
  const calls: string[] = [];
  view.useLocalOrganizationRemote({
    owns: (id) => id === "local",
    refresh: async () => {
      calls.push("snapshot");
      view.setLocalOrganization(owned.snapshot());
    },
    request: async (action, input) => {
      calls.push(action);
      if (action === "snapshot") return owned.snapshot();
      if (action === "pin") return owned.setPinned(String(input.sessionId), true);
      if (action === "archive") return owned.setArchived(String(input.sessionId), true);
      if (action === "rename") return owned.rename(String(input.workspaceId), String(input.title));
      if (action === "delete") return owned.delete(String(input.workspaceId));
      throw new Error("unexpected action");
    },
  });
  view.setLocalOrganization(owned.snapshot());
  view.setReferencePins(["official-pin"]);
  const rpc = new RpcRegistry();
  view.register(rpc, new StreamRegistry());
  assert.deepEqual(await invoke(rpc, "workspace/pinSession", { request: { sessionId: "local" } }), {
    pinnedSessionIds: ["official-pin", "local"],
  });
  await invoke(rpc, "workspace/archiveSession", { request: { sessionId: "local" } });
  assert.equal(view.isArchived("local"), true);
  await invoke(rpc, "workspace/rename", {
    request: { workspaceId: workspace.workspaceId, title: "Changed" },
  });
  assert.equal(view.get(workspace.workspaceId)?.title, "Changed");
  await invoke(rpc, "workspace/delete", { request: { workspaceId: workspace.workspaceId } });
  assert.equal(
    view.list().some((item) => item.workspaceId === workspace.workspaceId),
    false,
  );
  assert.deepEqual(calls, [
    "pin",
    "snapshot",
    "archive",
    "snapshot",
    "rename",
    "snapshot",
    "delete",
    "snapshot",
  ]);
  assert.deepEqual(readFileSync(data.path("workspaces.json")), original);
});

it("does not turn an acknowledged organization mutation into a resend after a snapshot failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-organization-ack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const view = new Workspaces(new DataDir(root), root, true);
  let writes = 0;
  view.useLocalOrganizationRemote({
    owns: (id) => id === "local",
    refresh: async () => {
      throw new Error("disconnected read");
    },
    request: async (action) => {
      if (action === "pin") {
        writes++;
        return ["local"];
      }
      throw new Error("disconnected read");
    },
  });
  view.setLocalOrganization({
    version: 1,
    items: [],
    pinnedSessionIds: [],
    archivedSessionIds: [],
  });
  const rpc = new RpcRegistry();
  view.register(rpc, new StreamRegistry());
  await invoke(rpc, "workspace/pinSession", { request: { sessionId: "local" } });
  assert.equal(writes, 1);
});

it("broadcasts owner ordering changes to an already attached gateway stream", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remote-organization-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const view = new Workspaces(new DataDir(root), root, true),
    streams = new StreamRegistry();
  let follow: StreamHandler | undefined;
  const register = streams.register.bind(streams);
  streams.register = (name, handler) => {
    if (name === "workspace/follow") follow = handler;
    register(name, handler);
  };
  view.register(new RpcRegistry(), streams);
  const frames: Array<{ type: string; workspaceIds?: string[] }> = [];
  assert.ok(follow);
  await follow(
    {},
    {
      id: "order",
      closed: false,
      push: (frame) => frames.push(frame as (typeof frames)[number]),
      onClose() {},
      end() {},
      fail() {},
    },
  );
  const now = new Date().toISOString();
  const first = {
    workspaceId: "first",
    path: root,
    title: "First",
    sessionIds: [],
    origin: "web" as const,
    createdAt: now,
    updatedAt: now,
  };
  const second = { ...first, workspaceId: "second", title: "Second" };
  view.setLocalOrganization({
    version: 1,
    items: [first, second],
    pinnedSessionIds: [],
    archivedSessionIds: [],
  });
  view.setLocalOrganization({
    version: 1,
    items: [second, first],
    pinnedSessionIds: [],
    archivedSessionIds: [],
  });
  assert.deepEqual(frames.filter((frame) => frame.type === "order").at(-1), {
    type: "order",
    workspaceIds: ["second", "first"],
  });
});
