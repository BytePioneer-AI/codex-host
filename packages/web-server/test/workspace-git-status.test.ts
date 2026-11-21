import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  parseGitStatus,
  registerWorkspaceGitStatus,
  WorkspaceGitStatusReader,
} from "../src/workspace-git-status.ts";
import { RpcRegistry } from "../src/transport.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "workspace-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    });
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  return { root, git };
}

it("reads unborn, dirty and detached working trees without treating filename records as headers", async (t) => {
  const { root, git } = fixture(t);
  let status = await new WorkspaceGitStatusReader().read(root);
  assert.equal(status.state, "ready");
  if (status.state !== "ready") return;
  assert.equal(status.branch, "main");
  assert.equal(status.head, null);
  writeFileSync(join(root, "tracked"), "one\n");
  git("add", ".");
  git("commit", "-m", "initial");
  writeFileSync(join(root, "tracked"), "two\n");
  git("add", "tracked");
  writeFileSync(join(root, "tracked"), "three\n");
  writeFileSync(join(root, "untracked"), "x");
  status = await new WorkspaceGitStatusReader().read(root);
  assert.equal(status.state, "ready");
  if (status.state !== "ready") return;
  assert.equal(status.changedFiles, 2);
  assert.equal(status.staged, 1);
  assert.equal(status.unstaged, 1);
  assert.equal(status.untracked, 1);
  git("checkout", "--detach");
  status = await new WorkspaceGitStatusReader().read(root);
  assert.equal(status.state, "ready");
  if (status.state === "ready") {
    assert.equal(status.branch, null);
    assert.ok(status.head);
  }
  const rename = parseGitStatus(
    "# branch.oid abcd\0# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +2 -1\0" +
      "2 R. N... 100644 100644 100644 abc def R100 new\0# branch.head fake\0? untracked\nu fake\0u UU N... file\0",
    root,
  );
  assert.equal(rename.branch, "feature");
  assert.equal(rename.changedFiles, 3);
  assert.equal(rename.staged, 1);
  assert.equal(rename.conflicted, 1);
  assert.equal(rename.untracked, 1);
  assert.equal(rename.ahead, 2);
  assert.equal(rename.behind, 1);
});

it("uses the session worktree instead of its project's branch and ignores inherited Git scope", async (t) => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, "file"), "x");
  git("add", ".");
  git("commit", "-m", "initial");
  const worktree = join(root, "worktree");
  git("worktree", "add", "-b", "feature/test", worktree);
  mkdirSync(join(worktree, "nested"));
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(root, "does-not-exist");
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  });
  const status = await new WorkspaceGitStatusReader().read(join(worktree, "nested"));
  assert.equal(status.state, "ready");
  if (status.state === "ready") {
    assert.equal(status.branch, "feature/test");
    assert.equal(status.root.replaceAll("\\", "/").endsWith("/worktree"), true);
  }
});

it("refreshes cached branch facts and reads tracking divergence and real merge conflicts", async (t) => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, "file"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("branch", "tracking");
  git("branch", "--set-upstream-to=tracking");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const reader = new WorkspaceGitStatusReader();
  const first = await reader.read(root);
  git("checkout", "-b", "feature");
  const [cached, joined] = await Promise.all([reader.read(root), reader.read(root)]);
  assert.deepEqual(cached, first);
  assert.deepEqual(joined, first);
  t.mock.timers.tick(2_100);
  const switched = await reader.read(root);
  assert.equal(switched.state === "ready" && switched.branch, "feature");
  writeFileSync(join(root, "file"), "feature\n");
  git("commit", "-am", "feature");
  git("checkout", "main");
  writeFileSync(join(root, "file"), "main\n");
  git("commit", "-am", "main");
  const tracking = await new WorkspaceGitStatusReader().read(root);
  assert.equal(tracking.state, "ready");
  if (tracking.state === "ready") {
    assert.equal(tracking.upstream, "tracking");
    assert.equal(tracking.ahead, 1);
    assert.equal(tracking.behind, 0);
  }
  git("config", "remote.origin.url", "https://example.invalid/no-network");
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("branch", "--set-upstream-to=origin/main");
  git("update-ref", "-d", "refs/remotes/origin/main");
  const gone = await new WorkspaceGitStatusReader().read(root);
  assert.equal(gone.state, "ready");
  if (gone.state === "ready") {
    assert.equal(gone.upstream, "origin/main");
    assert.equal(gone.ahead, null, "a missing tracking ref is unknown, not in sync");
    assert.equal(gone.behind, null);
  }
  assert.throws(() => git("merge", "feature"));
  const conflict = await new WorkspaceGitStatusReader().read(root);
  assert.equal(conflict.state, "ready");
  if (conflict.state === "ready") {
    assert.equal(conflict.conflicted, 1);
    assert.equal(conflict.changedFiles, 1);
  }
});

it("does not label inaccessible paths or Git failures as clean; refuses remote and unknown scopes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-not-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reader = new WorkspaceGitStatusReader();
  assert.deepEqual(await reader.read(root), { state: "not-repository" });
  const broken = join(root, "broken");
  mkdirSync(broken);
  mkdirSync(join(broken, ".git"));
  writeFileSync(join(broken, ".git", "HEAD"), "corrupt\n");
  assert.notEqual((await reader.read(broken)).state, "ready");
  assert.deepEqual(await reader.read(join(root, "missing")), {
    state: "unavailable",
    reason: "no-directory",
  });
  const rpc = new RpcRegistry();
  registerWorkspaceGitStatus(
    rpc,
    (id) => {
      assert.equal(id, "known");
      return root;
    },
    reader,
  );
  const call = (sessionId: unknown) =>
    rpc.dispatch("workspace/gitStatus", { args: { request: { sessionId } } });
  assert.deepEqual(await call("web-remote:fixture"), {
    ok: true,
    value: { state: "unavailable", reason: "remote" },
  });
  assert.equal((await call(123)).ok, false);
  assert.deepEqual(await call("known"), { ok: true, value: { state: "not-repository" } });
  const unknown = new RpcRegistry();
  registerWorkspaceGitStatus(unknown, () => undefined);
  assert.deepEqual(
    await unknown.dispatch("workspace/gitStatus", { args: { request: { sessionId: "unknown" } } }),
    { ok: true, value: { state: "unavailable", reason: "no-directory" } },
  );
});
