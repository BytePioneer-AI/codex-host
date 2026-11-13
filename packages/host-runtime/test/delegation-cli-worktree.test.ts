import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
} from "../src/delegation-types.js";

const execFileAsync = promisify(execFile);
let temporary: string;
let repository: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args]);
  return stdout.trim();
}

async function invoke(options: string[], responseStatus = 200) {
  const output = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    if (responseStatus === 0) throw new Error("Connection closed before the response");
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify(
        responseStatus === 200
          ? {
              threadId: "child",
              deepLink: "codex://threads/child",
              harnessId: "pi",
              status: "running",
              cwd: body.cwd,
            }
          : { error: { code: "DELEGATION_FAILED", message: "Harness failed to start" } },
      ),
      { status: responseStatus },
    );
  });
  const code = await runDelegationCli({
    arguments: ["delegate", "start", "--harness", "pi", "--task", "test", ...options],
    environment: {
      [DELEGATION_RUNTIME_ENDPOINT_ENV]: "http://127.0.0.1:4321",
      [DELEGATION_RUNTIME_TOKEN_ENV]: "token",
    },
    output,
    diagnosticOutput,
    fetchImpl,
  });
  const result = output.read()?.toString();
  const error = diagnosticOutput.read()?.toString();
  return {
    code,
    result: result ? JSON.parse(result) : undefined,
    error: error ? JSON.parse(error).error : undefined,
    fetchImpl,
  };
}

function worktreePath(branch: string): string {
  return path.join(temporary, "repository.worktrees", branch);
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "delegation-worktree-")));
  repository = path.join(temporary, "repository");
  await mkdir(repository);
  await git("init", "-b", "main");
  await git("config", "user.name", "Worktree Test");
  await git("config", "user.email", "worktree@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", path.join(temporary, "no-hooks"));
  await writeFile(path.join(repository, "tracked.txt"), "baseline\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});

describe("delegate start --worktree", () => {
  it.each(["json", "compact"])(
    "creates an isolated cwd and adds metadata in %s",
    async (format) => {
      const base = await git("rev-parse", "HEAD");
      await writeFile(path.join(repository, "tracked.txt"), "uncommitted\n");
      const { code, result, error, fetchImpl } = await invoke([
        "--cwd",
        repository,
        "--worktree",
        "feature/review",
        "--format",
        format,
      ]);
      const expected = worktreePath("feature-review");
      expect({ code, error }).toEqual({ code: 0, error: undefined });
      expect(result.worktree).toEqual({ path: expected, branch: "feature/review", base });
      expect(result.cwd).toBe(expected);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
        harnessId: "pi",
        task: "test",
        cwd: expected,
      });
      expect(result.thread ?? result.deepLink).toBe("codex://threads/child");
      expect(await git("-C", expected, "branch", "--show-current")).toBe("feature/review");
      expect(await readFile(path.join(expected, "tracked.txt"), "utf8")).toBe("baseline\n");
      expect(await git("branch", "--show-current")).toBe("main");
    },
  );

  it("resolves an explicit base to a commit", async () => {
    const base = await git("rev-parse", "HEAD");
    await writeFile(path.join(repository, "tracked.txt"), "second\n");
    await git("commit", "-am", "second");
    const { code, result } = await invoke([
      "--cwd",
      repository,
      "--worktree",
      "older",
      "--base",
      "HEAD~1",
    ]);
    expect(code).toBe(0);
    expect(result.worktree.base).toBe(base);
    expect(await git("rev-parse", "older")).toBe(base);
  });

  it("uses caller cwd and detached HEAD when cwd and base are omitted", async () => {
    const base = await git("rev-parse", "HEAD");
    await git("checkout", "--detach", base);
    vi.spyOn(process, "cwd").mockReturnValue(repository);
    const { code, result } = await invoke(["--worktree", "detached-child"]);
    expect(code).toBe(0);
    expect(result.worktree.base).toBe(base);
    expect(result.cwd).toBe(worktreePath("detached-child"));
  });

  it("uses the main repository location and linked source checkout's HEAD", async () => {
    const source = worktreePath("source");
    await git("worktree", "add", "-b", "source", source);
    await writeFile(path.join(source, "tracked.txt"), "linked commit\n");
    await git("-C", source, "commit", "-am", "linked");
    const base = await git("-C", source, "rev-parse", "HEAD");
    await mkdir(path.join(source, "nested"));
    const { code, result } = await invoke([
      "--cwd",
      path.join(source, "nested"),
      "--worktree",
      "linked-child",
    ]);
    expect(code).toBe(0);
    expect(result.worktree).toEqual({
      path: worktreePath("linked-child"),
      branch: "linked-child",
      base,
    });
  });

  it("rejects an existing branch without overwriting it", async () => {
    const base = await git("rev-parse", "HEAD");
    await git("branch", "existing");
    const { code, error, fetchImpl } = await invoke([
      "--cwd",
      repository,
      "--worktree",
      "existing",
    ]);
    expect(code).toBe(1);
    expect(error.message).toContain("branch already exists");
    expect(await git("rev-parse", "existing")).toBe(base);
    await expect(readFile(path.join(worktreePath("existing"), ".git"))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an existing sanitized directory without touching its contents", async () => {
    await mkdir(worktreePath("feature-review"), { recursive: true });
    const marker = path.join(worktreePath("feature-review"), "keep.txt");
    await writeFile(marker, "keep");
    const { code, error, fetchImpl } = await invoke([
      "--cwd",
      repository,
      "--worktree",
      "feature/review",
    ]);
    expect(code).toBe(1);
    expect(error.message).toContain("directory already exists");
    expect(await readFile(marker, "utf8")).toBe("keep");
    expect(await git("branch", "--list", "feature/review")).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects a merge/unmerged index (remove MERGE_HEAD=%s)",
    async (indexOnly) => {
      await git("checkout", "-b", "other");
      await writeFile(path.join(repository, "tracked.txt"), "other\n");
      await git("commit", "-am", "other");
      await git("checkout", "main");
      await writeFile(path.join(repository, "tracked.txt"), "main\n");
      await git("commit", "-am", "main");
      await expect(git("merge", "other")).rejects.toThrow();
      if (indexOnly)
        await rm(
          await git("rev-parse", "--git-path", "MERGE_HEAD").then((p) =>
            path.resolve(repository, p),
          ),
        );
      const { code, error, fetchImpl } = await invoke(["--cwd", repository, "--worktree", "child"]);
      expect(code).toBe(1);
      expect(error.message).toContain(indexOnly ? "unmerged index" : "in-progress merge");
      expect(await git("branch", "--list", "child")).toBe("");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["rebase-merge", "rebase-apply"])("rejects %s in a linked checkout", async (state) => {
    const source = worktreePath("source");
    await git("worktree", "add", "-b", "source", source);
    const statePath = await git(
      "-C",
      source,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      state,
    );
    await mkdir(statePath);
    const { code, error, fetchImpl } = await invoke(["--cwd", source, "--worktree", "child"]);
    expect(code).toBe(1);
    expect(error.message).toContain(state);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-Git cwd", async () => {
    const { code, error, fetchImpl } = await invoke(["--cwd", temporary, "--worktree", "child"]);
    expect(code).toBe(1);
    expect(error.message).toContain("not a Git working tree");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["no-such-ref", "--all"])(
    "rejects unresolved base %s before creating artifacts",
    async (base) => {
      const { code, error, fetchImpl } = await invoke([
        "--cwd",
        repository,
        "--worktree",
        "child",
        `--base=${base}`,
      ]);
      expect(code).toBe(1);
      expect(error.message).toContain("Cannot resolve worktree base");
      expect(await git("branch", "--list", "child")).toBe("");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["../escape", "-branch", "HEAD"])("rejects invalid branch %s", async (branch) => {
    const { code, error, fetchImpl } = await invoke(["--cwd", repository, `--worktree=${branch}`]);
    expect(code).toBe(1);
    expect(error.message).toContain("Invalid worktree branch");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects --base without --worktree", async () => {
    const { code, error, fetchImpl } = await invoke(["--base", "HEAD"]);
    expect(code).toBe(1);
    expect(error.message).toBe("--base requires --worktree");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates local options before creating a branch", async () => {
    const { code, error, fetchImpl } = await invoke([
      "--cwd",
      repository,
      "--worktree",
      "child",
      "--watch",
      "true",
      "--watch-timeout-ms",
      "invalid",
    ]);
    expect(code).toBe(1);
    expect(error.message).toContain("--watch-timeout-ms");
    expect(await git("branch", "--list", "child")).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { responseStatus: 500, errorCode: "DELEGATION_FAILED" },
    { responseStatus: 0, errorCode: "RUNTIME_UNREACHABLE" },
  ])(
    "reports retained worktree/branch on Runtime failure ($errorCode)",
    async ({ responseStatus, errorCode }) => {
      const { code, result, error } = await invoke(
        ["--cwd", repository, "--worktree", "child"],
        responseStatus,
      );
      expect(code).toBe(1);
      expect(result).toBeUndefined();
      expect(error.code).toBe(errorCode);
      expect(error.details.worktreeRetained).toBe(true);
      expect(error.details.worktree).toEqual({
        path: worktreePath("child"),
        branch: "child",
        base: await git("rev-parse", "HEAD"),
      });
      expect(error.message).toContain(worktreePath("child"));
      expect(await readFile(path.join(worktreePath("child"), "tracked.txt"), "utf8")).toBe(
        "baseline\n",
      );
    },
  );

  it("rolls back its reserved empty directory if branch creation fails", async () => {
    await git("branch", "topic/nested");
    const { code, error, fetchImpl } = await invoke(["--cwd", repository, "--worktree", "topic"]);
    expect(code).toBe(1);
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("Cannot create worktree branch 'topic'");
    expect(error.details?.worktreeRetained).not.toBe(true);
    await expect(mkdir(worktreePath("topic"))).resolves.toBeUndefined();
    expect(await git("branch", "--list", "topic")).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a branch left behind when checkout fails", async () => {
    await writeFile(path.join(repository, ".gitattributes"), "tracked.txt filter=broken\n");
    await git("add", ".gitattributes");
    await git("commit", "-m", "filter attribute");
    await git("config", "filter.broken.smudge", "git --invalid-delegation-test-filter");
    await git("config", "filter.broken.required", "true");
    const base = await git("rev-parse", "HEAD");
    const { code, error, fetchImpl } = await invoke([
      "--cwd",
      repository,
      "--worktree",
      "checkout-fails",
    ]);
    expect(code).toBe(1);
    expect(error.details.worktreeRetained).toBe(true);
    expect(error.details.worktree).toEqual({
      path: worktreePath("checkout-fails"),
      branch: "checkout-fails",
      base,
    });
    expect(await git("rev-parse", "checkout-fails")).toBe(base);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not execute checkout hooks", async () => {
    const hooks = path.join(temporary, "hooks");
    await mkdir(hooks);
    await writeFile(
      path.join(hooks, "post-checkout"),
      '#!/bin/sh\nprintf hook > "$PWD/post-checkout-ran"\n',
      { mode: 0o755 },
    );
    await git("config", "core.hooksPath", hooks);
    const { code } = await invoke(["--cwd", repository, "--worktree", "no-hooks"]);
    expect(code).toBe(0);
    await expect(
      readFile(path.join(worktreePath("no-hooks"), "post-checkout-ran")),
    ).rejects.toThrow();
  });

  it("leaves ordinary non-Git delegation unchanged without --worktree", async () => {
    const { code, result } = await invoke(["--cwd", temporary]);
    expect(code).toBe(0);
    expect(result.cwd).toBe(temporary);
    expect(result).not.toHaveProperty("worktree");
  });
});
