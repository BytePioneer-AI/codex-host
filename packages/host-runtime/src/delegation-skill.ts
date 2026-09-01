import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SKILL_VERSION = 4;
const SKILL_RELATIVE_PATH = path.join("skills", "codexhost-delegation", "SKILL.md");
const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "ba509f57e5448e796b3dfdd5031dcb08672eded50b61c0a54de84cfa02c49dd3",
  "d3ddf6db9bc5c5df825479c885bbbf0ca08da66f7057a12e02e1fdf57525149e",
  "15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d",
  "e2f8814ef21859f51af4afd3b0f8dc0f62b450acd671f8ed6f3522efe5aa2080",
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

When the user asks for a specific Model or Thinking level, inspect the target
Harness first and use the exact opaque IDs returned by the authoritative CLI.
When they do not specify either setting, omit it so the target keeps its default.

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

function destinations(home: string): string[] {
  return [
    path.join(home, ".agents", SKILL_RELATIVE_PATH),
    path.join(home, ".claude", SKILL_RELATIVE_PATH),
  ];
}

async function validateDestinationPath(
  home: string,
  destination: string,
  createParents: boolean,
): Promise<void> {
  const homeStat = await lstat(home);
  if (
    !homeStat.isDirectory() ||
    (homeStat.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && homeStat.uid !== process.getuid())
  ) {
    throw new Error(`Unsafe Skill home: ${home}`);
  }
  const relative = path.relative(home, destination);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Skill destination is outside home");
  let current = home;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index]!);
    try {
      const entry = await lstat(current);
      if (
        !entry.isDirectory() ||
        (entry.mode & 0o022) !== 0 ||
        (typeof process.getuid === "function" && entry.uid !== process.getuid())
      ) {
        throw new Error(`Unsafe Skill directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!createParents) return;
      await mkdir(current, { mode: 0o700 });
    }
  }
  const entry = await lstat(destination).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (
    entry &&
    (!entry.isFile() ||
      (entry.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && entry.uid !== process.getuid()))
  ) {
    throw new Error(`Unsafe Skill entry: ${destination}`);
  }
}

export type DelegationSkillState = "missing" | "current" | "managed-legacy" | "conflict";

export interface DelegationSkillLifecycleInput {
  homeDirectory?: string;
}

export interface DelegationSkillStatusResult {
  path: string;
  status: DelegationSkillState;
  version: number | null;
  digest: string | null;
}

export interface DelegationSkillUninstallResult {
  path: string;
  status: DelegationSkillState | "removed";
  version: number | null;
  digest: string | null;
}

function knownManagedDigests(): Set<string> {
  return new Set([CURRENT_DIGEST, ...PREVIOUS_MANAGED_DIGESTS]);
}

async function classifyDelegationSkill(
  home: string,
  destination: string,
  knownDigests: ReadonlySet<string>,
): Promise<DelegationSkillStatusResult> {
  await validateDestinationPath(home, destination, false);
  const current = await readOptional(destination);
  if (current === null) {
    return { path: destination, status: "missing", version: null, digest: null };
  }
  const currentDigest = digest(current);
  if (current === CODEXHOST_DELEGATION_SKILL) {
    return { path: destination, status: "current", version: SKILL_VERSION, digest: CURRENT_DIGEST };
  }
  return {
    path: destination,
    status: knownDigests.has(currentDigest) ? "managed-legacy" : "conflict",
    version: managedVersion(current),
    digest: currentDigest,
  };
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
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillInstallResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const destinationPaths = destinations(home);
  const knownDigests = knownManagedDigests();
  const results: DelegationSkillInstallResult[] = [];
  for (const destination of destinationPaths) {
    const classified = await classifyDelegationSkill(home, destination, knownDigests);
    if (classified.status === "current") {
      results.push({
        path: destination,
        status: "current",
        version: SKILL_VERSION,
        digest: CURRENT_DIGEST,
      });
      continue;
    }
    if (classified.status === "conflict") {
      results.push({
        path: classified.path,
        status: "conflict",
        version: classified.version,
        digest: classified.digest,
      });
      continue;
    }
    if (classified.status === "managed-legacy") {
      await validateDestinationPath(home, destination, true);
      await atomicWrite(destination, CODEXHOST_DELEGATION_SKILL);
      results.push({
        path: destination,
        status: "updated",
        version: SKILL_VERSION,
        digest: CURRENT_DIGEST,
      });
      continue;
    }
    await validateDestinationPath(home, destination, true);
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

export async function inspectDelegationSkills(
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillStatusResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const knownDigests = knownManagedDigests();
  return Promise.all(
    destinations(home).map((destination) =>
      classifyDelegationSkill(home, destination, knownDigests),
    ),
  );
}

export async function uninstallDelegationSkills(
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillUninstallResult[]> {
  const home = input.homeDirectory ?? os.homedir();
  const knownDigests = knownManagedDigests();
  const results: DelegationSkillUninstallResult[] = [];
  for (const destination of destinations(home)) {
    const classified = await classifyDelegationSkill(home, destination, knownDigests);
    if (classified.status !== "current" && classified.status !== "managed-legacy") {
      results.push(classified);
      continue;
    }
    const quarantine = path.join(path.dirname(destination), `.SKILL.md.${randomUUID()}.quarantine`);
    try {
      await rename(destination, quarantine);
      const verified = await classifyDelegationSkill(home, quarantine, knownDigests);
      if (verified.status === "current" || verified.status === "managed-legacy") {
        await rm(quarantine);
        results.push({ ...classified, status: "removed" });
      } else {
        await rename(quarantine, destination);
        results.push(classified);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        results.push({ path: destination, status: "missing", version: null, digest: null });
        continue;
      }
      throw error;
    }
  }
  return results;
}
