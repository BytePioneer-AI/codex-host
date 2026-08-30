import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_VERSION = 3;
const SKILL_RELATIVE_PATH = path.join("skills", "codexhost-delegation", "SKILL.md");
const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "ba509f57e5448e796b3dfdd5031dcb08672eded50b61c0a54de84cfa02c49dd3",
  "d3ddf6db9bc5c5df825479c885bbbf0ca08da66f7057a12e02e1fdf57525149e",
];

export const CODEXHOST_DELEGATION_SKILL = `---
name: codexhost-delegation
version: ${SKILL_VERSION}
description: >
  Delegate work to another coding agent. Use when the user explicitly asks
  Claude Code, Pi, Codex/OpenAI, OMP, Grok, another agent, or an agent mentioned
  as @<agent> to independently review, investigate, implement, test, or verify
  something. Do not use when the user is merely discussing, comparing, or
  configuring agents, choosing a Model or Provider, or asking the current agent
  to role-play as another agent.
---

# Execute the task

Before acting, run:

\`codexhost delegate --help\`

Treat its output as the sole authoritative source for:

- available commands;
- command parameters;
- available target Harness IDs;
- Thread identifier formats;
- waiting and reading behavior;
- response fields;
- errors and recovery guidance.

Do not construct commands, parameters, or Harness IDs from memory.

Create an independent child session and submit the requested task.

After starting the task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- wait for a bounded period;
- check it again later;
- leave it running in the background.

When the result is needed, explicitly read the child Thread. Report only the
visible result returned by that Thread.

Provide the user with the necessary tracking information, including:

- target agent;
- \`delegationId\`;
- \`threadId\`;
- \`turnId\`;
- \`deepLink\`;
- current or final status.
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
