import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { Workspaces } from "../src/workspaces.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { registerWorkspaceGitStatus } from "../src/workspace-git-status.ts";
import { FakeChHost } from "./support/ch-host.ts";

it("Git scopes require a server workspace binding, not a draft cwd or its automatic mirror", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "git-draft-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = join(root, "allowed"),
    foreign = join(root, "foreign");
  mkdirSync(allowed);
  mkdirSync(foreign);
  const host = new FakeChHost();
  host.add("confirmed-thread", foreign);
  const ws = new Workspaces(new DataDir(root), root);
  const registered = ws.create(allowed).workspace;
  const sessions = new ChSessions(host, ws, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry(),
    streams = new StreamRegistry();
  ws.register(rpc, streams);
  sessions.register(rpc, streams);
  registerWorkspaceGitStatus(rpc, (id) => sessions.gitWorkspaceRoot(id));
  const create = async (request: object) => {
    const reply = await rpc.dispatch("session/create", { args: { request } });
    assert.ok(reply.ok);
    return (reply.value as { sessionId: string }).sessionId;
  };
  const arbitrary = await create({ cwd: foreign });
  assert.equal(sessions.gitWorkspaceRoot(arbitrary), undefined);
  const autoMirror = ws.byPath(foreign);
  assert.ok(autoMirror);
  const recycled = await create({ workspaceId: autoMirror.workspaceId });
  assert.equal(
    sessions.gitWorkspaceRoot(recycled),
    undefined,
    "draft-created mirrors are not authorization",
  );
  const denied = await rpc.dispatch("workspace/gitStatus", {
    args: { request: { sessionId: arbitrary } },
  });
  assert.deepEqual(denied, { ok: true, value: { state: "unavailable", reason: "no-directory" } });
  const forged = await create({ workspaceId: registered.workspaceId, cwd: foreign });
  assert.equal(sessions.gitWorkspaceRoot(forged), undefined);
  const bound = await create({ workspaceId: registered.workspaceId });
  assert.equal(sessions.gitWorkspaceRoot(bound), allowed);
  await rpc.dispatch("workspace/delete", {
    args: { request: { workspaceId: registered.workspaceId } },
  });
  assert.equal(sessions.gitWorkspaceRoot(bound), undefined, "removed bindings are revalidated");
  assert.ok((await rpc.dispatch("session/list", { args: {} })).ok);
  assert.equal(
    sessions.gitWorkspaceRoot("confirmed-thread"),
    foreign,
    "canonical cwd comes from Host",
  );
});
