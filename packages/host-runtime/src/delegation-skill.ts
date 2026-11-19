import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_VERSION = 15;
export const DELEGATION_SKILL_NAME = "codexhost-delegation";
const SKILL_RELATIVE_PATH = path.join("skills", DELEGATION_SKILL_NAME, "SKILL.md");
const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "9d2f491850fb0b4084a31ba9b5e4a550b5e833747af322090d8ed0ff80b88c30",
  "2bb0aebb9b06febbc6c0c0bcdb0b32506c7cdbf8dc3b734cc6b2a86621270e4e",
  "aff258622dc8ff321f32b15620d081e578cb9c9ed1134d6a57f35ca8e7762c0a",
  "ba509f57e5448e796b3dfdd5031dcb08672eded50b61c0a54de84cfa02c49dd3",
  "d3ddf6db9bc5c5df825479c885bbbf0ca08da66f7057a12e02e1fdf57525149e",
  "15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d",
  // v4, shipped in v0.4.0-v0.6.0.
  "fa7944cd1e72ffbaf932fca2074bdb78aad4670d8990b6711220dd83c39509a0",
  "b9c1cce41d2556e73a6514aa55618d7d3f2f9ef935f5ae50b0da5a04941514b4",
  // v8, which ran a bare `codexhost` from PATH.
  "ca06be59f0d47c9a54d05ed2d9588c9c737306cc155cb4dff3fe2a2a61891dde",
  // v9, before the child-session name guidance.
  "b72a059e139bd5b93b95f7ac02ab80f428d5a721cc67b004210d5263e75baed7",
  // v10.
  "242a07e7521949e5d651102f6b353c48e7575a679e3403c5c5db295abad9896b",
  // v11, before the worktree note.
  "e762e3dea2633656dec27ea568b95f005e7f5c13a21b029dd149813f49c1330c",
  // v12, before the thread export note.
  "1c238d035647b40f6f6db17409e31e1723fbe57c5aa1aaf35487686aecb65b6f",
  // v13, before the content split with CLI help.
  "fc3d2a7d88de1da2e57853faa086661defdaf92c054d6f0c01953d10aee5f351",
  // Earlier fork-managed question templates.
  "fb3b555c90030b7c9e506ba0eb7e4a584efc1e7b369c552bf1d93daaffa9a310",
  "a6e753ed092239429ebc0dcba8090fb9425fa65292b7810ba990c13a531816a6",
  // v14, before the delegated question workflow.
  "75eb0ea22c8e3ce875a62133c10d62fedacf381e25202d01688210dd951324c1",
  // Fork v13, before the content split with CLI help.
  "41c2672e34b7a52dee9111f8284a4261b4dbcd42908262dcc814b323bb278e59",
];

export const CODEXHOST_DELEGATION_SKILL = `---
name: codexhost-delegation
version: ${SKILL_VERSION}
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, answer its
  questions, wait, or cancel a task. Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

Run the CLI through the executable in CODEXHOST_CLI_PATH, using the form for
your shell:

- POSIX: \`"$CODEXHOST_CLI_PATH" delegate --help\`
- PowerShell: \`& $env:CODEXHOST_CLI_PATH delegate --help\`
- cmd: \`"%CODEXHOST_CLI_PATH%" delegate --help\`

If CODEXHOST_CLI_PATH is unset, try \`codexhost\`; if that also fails, tell the
user to add CODEXHOST_CLI_PATH to shell_environment_policy.include_only.
Commands shown by help and in \`next\` begin with \`codexhost\`; run them the
same way.

The help is the authoritative source for commands and behavior. Read the
command index first when the target is unknown, then the specific command's help
before using its options. Prefer compact output when supported, and use its task
links directly for subsequent commands.

When users want delegation in another app, suggest the external CLI, HTTP or MCP.
The running Host saves private local credentials in ~/.codexhost/cli-credentials.json
(or the configured data directory); same-user CLI calls read them automatically.
HTTP/MCP clients can use that token in Authorization: Bearer <token>.
For a separate client identity, run \`codexhost client add <name>\` and store the
returned token privately. Host-started sessions keep their injected credentials.

Use the Harness native defaults unless a Model or Thinking selection is needed.

For a new delegation, create an independent child session and submit the
requested task. Give it a short task name that tells it apart from sibling
tasks. When the change is large, or parallel tasks may touch the same files, an
isolated git worktree for the child is an option. For an existing external
session, resolve the target from the user-provided session link, identifier, or
context and operate on that Thread directly; it need not have been created by
the current assistant. If the target is ambiguous, ask the user to identify it.
Keep requests to view or summarize a session read-only.

Then choose the next action from the user's request: send a follow-up, cancel,
read now, answer a pending question, wait for a bounded period, check later, or
watch it so the Host notifies this Thread once when it stops or needs input.
You can also leave it running. A watch notification
reports execution state only; read the Thread before judging or reporting its
work. Only when debugging needs the full Thread, export it to a file.

For a pending question, read the Thread and follow the answer command's help.
After answering, read or watch again; submission does not prove completion.
Questions requiring the user's decision or additional authorization belong to
the user.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
`;

const CURRENT_DIGEST = createHash("sha256").update(CODEXHOST_DELEGATION_SKILL).digest("hex");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function managedVersion(value: string): number | null {
  const match = /^version:\s*(\d+)\s*$/mu.exec(value);
  return match ? Number(match[1]) : null;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.SKILL.md.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export type DelegationSkillInstallStatus = "installed" | "updated" | "current" | "conflict";

export interface DelegationSkillInstallResult {
  path: string;
  status: DelegationSkillInstallStatus;
  version: number | null;
  digest: string | null;
}

export async function installDelegationSkills(
  input: {
    homeDirectory?: string;
    previousManagedDigests?: readonly string[];
  } = {},
): Promise<DelegationSkillInstallResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const destinations = [
    path.join(home, ".agents", SKILL_RELATIVE_PATH),
    path.join(home, ".claude", SKILL_RELATIVE_PATH),
  ];
  const knownDigests = new Set([
    CURRENT_DIGEST,
    ...PREVIOUS_MANAGED_DIGESTS,
    ...(input.previousManagedDigests ?? []),
  ]);
  const results: DelegationSkillInstallResult[] = [];
  for (const destination of destinations) {
    const current = await readOptional(destination);
    if (current === CODEXHOST_DELEGATION_SKILL) {
      results.push({
        path: destination,
        status: "current",
        version: SKILL_VERSION,
        digest: CURRENT_DIGEST,
      });
      continue;
    }
    if (current !== null) {
      const currentDigest = digest(current);
      const version = managedVersion(current);
      if (!knownDigests.has(currentDigest)) {
        results.push({ path: destination, status: "conflict", version, digest: currentDigest });
        continue;
      }
      await atomicWrite(destination, CODEXHOST_DELEGATION_SKILL);
      results.push({
        path: destination,
        status: "updated",
        version: SKILL_VERSION,
        digest: CURRENT_DIGEST,
      });
      continue;
    }
    await atomicWrite(destination, CODEXHOST_DELEGATION_SKILL);
    results.push({
      path: destination,
      status: "installed",
      version: SKILL_VERSION,
      digest: CURRENT_DIGEST,
    });
  }
  for (const result of results) {
    if (result.status === "conflict") continue;
    const source = await readFile(result.path, "utf8");
    const metadata = await stat(result.path);
    if (!metadata.isFile() || source !== CODEXHOST_DELEGATION_SKILL) {
      throw new Error(`Delegation Skill verification failed: ${result.path}`);
    }
  }
  const managed = results.filter((result) => result.status !== "conflict");
  if (managed.some((result) => result.digest !== CURRENT_DIGEST)) {
    throw new Error("Delegation Skill copies are inconsistent");
  }
  if (results.every((result) => result.status !== "conflict")) {
    const copies = await Promise.all(results.map((result) => readFile(result.path, "utf8")));
    if (copies.some((copy) => copy !== copies[0])) {
      throw new Error("Delegation Skill copies are inconsistent");
    }
  }
  return results;
}

/**
 * Path of the Codex-visible (`~/.agents`) Skill copy, only while it still holds
 * the managed content. A user-managed conflicting copy is never referenced.
 */
export async function managedDelegationSkillReference(
  input: { homeDirectory?: string } = {},
): Promise<{ name: string; path: string } | null> {
  const filePath = path.join(input.homeDirectory ?? os.homedir(), ".agents", SKILL_RELATIVE_PATH);
  try {
    return (await readOptional(filePath)) === CODEXHOST_DELEGATION_SKILL
      ? { name: DELEGATION_SKILL_NAME, path: filePath }
      : null;
  } catch {
    return null;
  }
}
