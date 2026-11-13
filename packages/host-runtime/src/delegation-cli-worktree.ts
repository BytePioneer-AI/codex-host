import { execFile } from "node:child_process";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { DelegationControlError } from "./delegation-types.js";

const execFileAsync = promisify(execFile);

export interface DelegationWorktree {
  path: string;
  branch: string;
  /** Resolved commit, including when the caller omitted --base (HEAD). */
  base: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
    { timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true },
  );
  return stdout.trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function invalid(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

/** Checks the source checkout's own Git state, not another worktree's index. */
async function checkRepository(cwd: string): Promise<string> {
  let root: string;
  try {
    root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw invalid(`--worktree cwd is not a Git working tree: ${cwd}`);
  }
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply"]) {
    const state = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", name]);
    if (await exists(state))
      throw invalid(`Git working tree has an in-progress merge or rebase (${name}): ${root}`);
  }
  if (await git(root, ["ls-files", "--unmerged"]))
    throw invalid(`Git working tree has an unmerged index: ${root}`);
  return root;
}

function retainedError(error: unknown, worktree: DelegationWorktree): DelegationControlError {
  const original = error instanceof DelegationControlError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new DelegationControlError(
    original?.code ?? "INTERNAL_ERROR",
    `${message}; worktree/branch may remain at ${worktree.path} (${worktree.branch})`,
    { ...original?.details, worktree, worktreeRetained: true },
  );
}

async function createWorktree(input: {
  cwd: string;
  branch: string;
  base?: string | undefined;
}): Promise<DelegationWorktree> {
  const root = await checkRepository(input.cwd);
  // Validate the literal ref: --branch would expand checkout shorthand such as @{-1}.
  if (input.branch.startsWith("-") || input.branch === "HEAD")
    throw invalid(`Invalid worktree branch: ${input.branch}`);
  try {
    await git(root, ["check-ref-format", `refs/heads/${input.branch}`]);
  } catch {
    throw invalid(`Invalid worktree branch: ${input.branch}`);
  }
  const branches = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  if (branches.split("\n").includes(`refs/heads/${input.branch}`))
    throw invalid(`Git branch already exists: ${input.branch}`);

  let base: string;
  try {
    base = await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${input.base ?? "HEAD"}^{commit}`,
    ]);
  } catch {
    throw invalid(`Cannot resolve worktree base to a commit: ${input.base ?? "HEAD"}`);
  }
  // The first entry is the main working tree, even when cwd is a linked worktree.
  const listed = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const main = listed.split("\0")[0]?.slice("worktree ".length);
  if (!main || !path.isAbsolute(main)) throw invalid("Cannot determine the main Git worktree");
  const directory = input.branch.replace(/[^a-zA-Z0-9._-]/gu, "-");
  const parent = path.join(path.dirname(main), `${path.basename(main)}.worktrees`);
  const worktree = { path: path.join(parent, directory), branch: input.branch, base };
  if (await exists(worktree.path))
    throw invalid(`Worktree directory already exists: ${worktree.path}`);
  await mkdir(parent, { recursive: true });
  // Reserve the path exclusively before touching refs; never reuse an existing directory.
  try {
    await mkdir(worktree.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw invalid(`Worktree directory already exists: ${worktree.path}`);
    throw error;
  }
  let branchCreated = false;
  try {
    await git(root, ["branch", "--", input.branch, base]);
    branchCreated = true;
    // A linked checkout's .git is a file, so this hooks directory cannot exist.
    await git(root, [
      "-c",
      `core.hooksPath=${path.join(worktree.path, ".git", "hooks")}`,
      "worktree",
      "add",
      "--",
      worktree.path,
      input.branch,
    ]);
    return worktree;
  } catch (error) {
    if (branchCreated) {
      // A failed/timed-out checkout can leave files or registration; preserve and report them.
      throw retainedError(error, worktree);
    }
    const removed = await rmdir(worktree.path).then(
      () => true,
      () => false,
    );
    const refs = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).catch(
      () => undefined,
    );
    if (removed && refs !== undefined && !refs.split("\n").includes(`refs/heads/${input.branch}`)) {
      throw invalid(
        `Cannot create worktree branch '${input.branch}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw retainedError(error, worktree);
  }
}

/** CLI-owned filesystem preparation; the Runtime receives only the effective cwd. */
export async function startWithDelegationWorktree(
  input: { cwd?: string | undefined; branch?: string | undefined; base?: string | undefined },
  start: (cwd: string | undefined) => Promise<unknown>,
): Promise<unknown> {
  if (!input.branch) {
    if (input.base !== undefined) throw invalid("--base requires --worktree");
    return start(input.cwd);
  }
  const worktree = await createWorktree({
    cwd: input.cwd ?? process.cwd(),
    branch: input.branch,
    base: input.base,
  });
  try {
    const result = await start(worktree.path);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new DelegationControlError("INTERNAL_ERROR", "Invalid delegation start response");
    return { ...result, worktree };
  } catch (error) {
    // The request may have started a Thread even if its response never reached the CLI.
    throw retainedError(error, worktree);
  }
}
