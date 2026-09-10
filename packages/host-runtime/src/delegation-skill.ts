import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_VERSION = 8;
const SKILL_RELATIVE_PATH = path.join("skills", "codexhost-delegation", "SKILL.md");
/**
 * Digests of every previously shipped managed Skill. A released digest missing
 * from this list makes the installer treat that copy as user-modified, so the
 * affected installations silently stop receiving Skill updates.
 */
export const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "20314c67b7be9cd9aaba81949ed87495d3b0f90760c1c43fdd62bfeaef069b86",
  "aff258622dc8ff321f32b15620d081e578cb9c9ed1134d6a57f35ca8e7762c0a",
  "ba509f57e5448e796b3dfdd5031dcb08672eded50b61c0a54de84cfa02c49dd3",
  "d3ddf6db9bc5c5df825479c885bbbf0ca08da66f7057a12e02e1fdf57525149e",
  "15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d",
  "fa7944cd1e72ffbaf932fca2074bdb78aad4670d8990b6711220dd83c39509a0",
  "2bb0aebb9b06febbc6c0c0bcdb0b32506c7cdbf8dc3b734cc6b2a86621270e4e",
  "b56eed6ba542100284e0cd77f97a4feb2e522c2048b43bb8c9aed642950fc32a",
];

export const CODEXHOST_DELEGATION_SKILL = `---
name: codexhost-delegation
version: ${SKILL_VERSION}
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, wait, or
  cancel a task. Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

The \`CODEXHOST_CLI_PATH\` environment variable holds the absolute path of the CLI
for this Host. Always invoke the CLI through that path. Do not run a bare
\`codexhost\`: it is absent from \`PATH\` in some installations and may resolve to a
different Host's CLI. If the variable is not set, report that delegation is
unavailable from this session instead of searching \`PATH\`.

Before acting, run the help command, using the syntax of the shell you execute
commands in:

- POSIX shells: \`"$CODEXHOST_CLI_PATH" delegate --help\`
- PowerShell: \`& $env:CODEXHOST_CLI_PATH delegate --help\`
- cmd: \`"%CODEXHOST_CLI_PATH%" delegate --help\`

Treat its output as the sole authoritative source for:

- available commands;
- command parameters;
- available target Harness IDs;
- Thread identifier formats;
- waiting and reading behavior;
- response fields;
- errors and recovery guidance.

Do not construct commands, parameters, or Harness IDs from memory.

When the user asks for a specific Model or Thinking level, inspect the target
Harness first and use the exact opaque IDs returned by the authoritative CLI.
When they do not specify either setting, omit it so the target keeps its default.

For a new delegation, create an independent child session and submit the
requested task. For an existing external session, resolve the target from the
user-provided session link, identifier, or context and operate on that Thread
directly; it need not have been created by the current assistant. If the target
is ambiguous, ask the user to identify it. Keep requests to view or summarize a
session read-only.

For a new or existing task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- wait for a bounded period;
- check it again later;
- leave it running in the background.

When the result is needed, explicitly read the target Thread. Report only the
visible result returned by that Thread.

Provide the user with the necessary tracking information available from the
CLI; omit unavailable fields rather than inventing them:

- target agent;
- \`delegationId\`;
- \`threadId\`;
- \`turnId\`;
- \`deepLink\`;
- current or final status.

Reuse \`--request-id\` for the same parent, Harness, cwd, task, and configuration.
A conflicting parent, cwd, task, or configuration with that ID must be rejected;
do not invent a new request-id to retry an UNKNOWN or cancelled task.

Use compact \`thread status\` for an immediate check and \`thread wait-many\`
for one bounded batch wait. When only actionable changes are needed, prefer
\`thread observe\`: it renews wait-many internally, tracks revisions, suppresses
ordinary progress, and returns once on completion/failure, pending input, changed
Turn, resync/error, a review deadline, or total timeout. It does not call a Model.
Set per-target \`reviewAt\` deadlines and one bounded overall timeout from the
current help. Consume \`result.targets\` to resume; remove handled terminal targets
and advance handled deadlines. Read only changed Threads and request tool/file
proof through \`thread evidence\`; hashes and self-reports are not execution proof.

The outer shell/tool must itself support sustained waiting. Keep one observer
process and its process handle when the tool yields; do not start duplicate
observers. If programmatic tool orchestration is available, await all process-handle
polls inside one tool invocation and allow that invocation to outlast the
observer timeout. Repeated outer tool polling can still cause Model calls. Never claim
zero coordinator wakeups from the observer process alone or promise it can wake
a suspended parent. Missing \`pendingInteractions\` is reported as
\`inputVisibilityUnavailable\`, not assumed to mean no input is needed. Observer
SIGINT/SIGTERM stops observation only; it does not cancel or release child work.

Cancel only acknowledges the cancel request and Turn terminal. It is not job
quiescence. Do not release a worktree, process, or business resource until
\`thread release\` reports owned-job quiescence \`confirmed\`. \`unknown\` and
\`unsupported\` stay fail-closed. \`always-approve\` is the Grok unattended
permission mode; it is not an OS read-only sandbox. Independent review requires
a new task plus prompt/readback, not a sandbox flag.

Inspect the target Harness before selecting Model or Thinking. Preserve the
caller-specified Harness and Model; never silently switch to Codex. Recover a
creating or unreadable child with \`delegate reconcile\` (dry-run first).
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
