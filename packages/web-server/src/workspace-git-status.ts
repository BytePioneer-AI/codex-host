import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorkspaceGitStatus } from "@codexhost/shared-contracts";
import { requestOf } from "./store.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

const exec = promisify(execFile);
type Ready = Extract<WorkspaceGitStatus, { state: "ready" }>;

/** -z records keep newlines/spaces in filenames from becoming status entries. */
export function parseGitStatus(output: string, root: string): Ready {
  const result: Ready = {
    state: "ready",
    root,
    branch: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    changedFiles: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    checkedAt: new Date().toISOString(),
  };
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const branch = record.slice(14);
      result.branch = branch === "(detached)" ? null : branch;
    } else if (record.startsWith("# branch.oid ")) {
      const head = record.slice(13);
      result.head = head === "(initial)" ? null : head;
    } else if (record.startsWith("# branch.upstream ")) result.upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(record);
      if (!match) throw new Error("Invalid Git branch status");
      result.ahead = Number(match[1]);
      result.behind = Number(match[2]);
    } else if (record.startsWith("? ")) {
      result.changedFiles++;
      result.untracked++;
    } else if (/^[12u] /u.test(record)) {
      const xy = record.slice(2, 4);
      if (xy.length !== 2) throw new Error("Invalid Git file status");
      result.changedFiles++;
      if (record[0] === "u") result.conflicted++;
      else {
        if (xy[0] !== ".") result.staged++;
        if (xy[1] !== ".") result.unstaged++;
      }
      if (record[0] === "2") index++; // Rename/copy has a second, arbitrary pathname.
    } else if (!record.startsWith("# ") && !record.startsWith("! ")) {
      throw new Error("Invalid Git status record");
    }
  }
  if (result.branch === null && result.head === null) throw new Error("Missing Git HEAD");
  return result;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  // A Web server may have been launched from another repository. Never inherit
  // its Git scope, alternate index or injected config when inspecting a Thread.
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

export class WorkspaceGitStatusReader {
  private readonly cache = new Map<
    string,
    { expires: number; value: Promise<WorkspaceGitStatus> }
  >();
  private active = 0;

  async read(cwd: string): Promise<WorkspaceGitStatus> {
    let directory: string;
    try {
      directory = await realpath(cwd);
    } catch {
      return { state: "unavailable", reason: "no-directory" };
    }
    const cached = this.cache.get(directory);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.active >= 4) return { state: "unavailable", reason: "git-failed" };
    this.active++;
    const entry = {
      expires: Infinity,
      value: Promise.resolve<WorkspaceGitStatus>({ state: "unavailable", reason: "git-failed" }),
    };
    entry.value = this.inspect(directory).finally(() => {
      this.active--;
      entry.expires = Date.now() + 2_000;
    });
    this.cache.delete(directory);
    this.cache.set(directory, entry);
    if (this.cache.size > 128) {
      for (const [key, item] of this.cache) {
        if (item.expires !== Infinity) {
          this.cache.delete(key);
          break;
        }
      }
    }
    return entry.value;
  }

  private async inspect(cwd: string): Promise<WorkspaceGitStatus> {
    const run = (args: string[]) =>
      exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
        env: gitEnvironment(),
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      });
    try {
      const { stdout: root } = await run(["rev-parse", "--show-toplevel"]);
      const { stdout } = await run([
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      return parseGitStatus(stdout, root.replace(/[\r\n]+$/u, ""));
    } catch (error) {
      const failure = error as { stderr?: string; code?: unknown };
      if (failure.code === 128 && failure.stderr?.includes("not a git repository"))
        return { state: "not-repository" };
      return { state: "unavailable", reason: "git-failed" };
    }
  }
}

export function registerWorkspaceGitStatus(
  rpc: RpcRegistry,
  workspace: (id: string) => string | undefined,
  reader = new WorkspaceGitStatusReader(),
): void {
  rpc.register("workspace/gitStatus", async (args) => {
    const { sessionId } = requestOf<{ sessionId?: unknown }>(args);
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 1_024)
      throw new RpcError("gateway/bad-request", "A session identity is required.");
    if (sessionId.startsWith("web-remote:")) return { state: "unavailable", reason: "remote" };
    const cwd = workspace(sessionId);
    return cwd ? reader.read(cwd) : { state: "unavailable", reason: "no-directory" };
  });
}
