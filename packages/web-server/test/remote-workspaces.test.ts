import assert from "node:assert/strict";
import { it } from "node:test";
import { remoteWorkspaceGroups } from "../src/remote-workspaces.ts";
import { RemoteSessions } from "../src/remote-sessions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub } from "../src/transport.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("separates identical remote project names and paths and keeps unmatched sessions visible", () => {
  const hosts = ["mac", "gateway"].map((name) => ({
    hostId: `remote-ssh-discovered:${name}`,
    displayName: name,
    online: name === "mac",
    projects: [{ id: "project", name: "playcodex", path: "/home/work", threadIds: [] }],
  }));
  const groups = remoteWorkspaceGroups(hosts, [
    {
      sessionId: "a",
      hostId: "remote-ssh-discovered:mac",
      threadId: "same",
      cwd: "/home/work/tree",
    },
    {
      sessionId: "b",
      hostId: "remote-ssh-discovered:gateway",
      threadId: "same",
      cwd: "/home/work",
    },
    { sessionId: "c", hostId: "remote-ssh-discovered:mac", threadId: "else", cwd: "/unregistered" },
  ]);
  assert.equal(new Set(groups.map((g) => g.workspaceId)).size, 3);
  assert.deepEqual(groups.flatMap((g) => g.sessionIds).sort(), ["a", "b", "c"]);
  assert.equal(groups.find((g) => g.sessionIds.includes("a"))?.remote?.displayName, "mac");
  assert.equal(groups.find((g) => g.sessionIds.includes("b"))?.remote?.state, "disconnected");
});
it("collects all remote pages into registered project groups, preserves offline rows and rejects local tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "remote-workspaces-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspaces = new Workspaces(new DataDir(dir), dir);
  workspaces.create(dir);
  let online = true;
  const pages: number[] = [];
  const remote = new RemoteSessions(
    new EventHub("projects"),
    async (op) => {
      if (op.kind === "hosts")
        return [
          {
            hostId: "remote-ssh-discovered:mac",
            displayName: "mac",
            online,
            state: online ? "connected" : "disconnected",
            projects: [{ id: "p", name: "playcodex", path: "/remote/project", threadIds: [] }],
          },
        ];
      if (op.kind !== "list") throw new Error("read-only catalog test");
      const offset = Number(op.cursor ?? 0);
      pages.push(offset);
      return {
        data: Array.from({ length: 100 }, (_, i) => ({
          id: String(offset + i),
          cwd: "/remote/project",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 2,
          status: { type: "idle" },
        })),
        nextCursor: offset === 200 ? null : String(offset + 100),
      };
    },
    workspaces,
  );
  t.after(() => remote.close());
  await remote.refresh();
  assert.deepEqual(pages, [0, 100, 200]);
  const group = workspaces.list().find((g) => g.remote);
  assert.ok(group);
  assert.equal(group.sessionIds.length, 300);
  assert.equal(workspaces.list()[0]?.workspaceId, group.workspaceId);
  assert.throws(() => workspaces.get(group.workspaceId), /remote project creation/);
  online = false;
  await remote.refresh();
  assert.equal(workspaces.list().find((g) => g.remote)?.sessionIds.length, 300);
  assert.equal(workspaces.list().find((g) => g.remote)?.remote?.state, "disconnected");
});
