import { createHash, randomUUID } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const SKILL_VERSION = 4;
const SKILL_RELATIVE_PATH = path.join("skills", "codexhost-delegation", "SKILL.md");
const PREVIOUS_MANAGED_DIGESTS: readonly string[] = [
  "15eb63519ff867e1536c97188a0c43738d7a49d38d4d6adeb7a1036726e7246d",
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
const nativeRealpath = promisify(realpathCallback.native);

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
  hooks?: DelegationSkillTestHooks,
): Promise<void> {
  const checkedLstat = (filePath: string): Promise<Stats> =>
    hooks?.lstat?.(filePath, () => lstat(filePath)) ?? lstat(filePath);
  const homeStat = await checkedLstat(home);
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
    const part = parts[index];
    if (!part) throw new Error(`Unsafe Skill destination: ${destination}`);
    current = path.join(current, part);
    try {
      const entry = await checkedLstat(current);
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
  const entry = await checkedLstat(destination).catch((error: unknown) => {
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
  const parent = path.dirname(destination);
  if ((await nativeRealpath(parent)) !== parent) {
    throw new Error(`Unsafe Skill directory: ${parent}`);
  }
}

async function canonicalHome(home: string): Promise<string> {
  const canonical = await nativeRealpath(home);
  const lexicalCanonical = await realpath(path.resolve(home));
  if (canonical !== lexicalCanonical) {
    throw new Error(`Ambiguous Skill home: ${home}`);
  }
  return canonical;
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
  hooks?: DelegationSkillTestHooks,
): Promise<DelegationSkillStatusResult> {
  await validateDestinationPath(home, destination, false, hooks);
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

export type DelegationSkillInstallStatus = "installed" | "updated" | "current" | "conflict";

export interface DelegationSkillInstallResult {
  path: string;
  status: DelegationSkillInstallStatus;
  version: number | null;
  digest: string | null;
}

export interface DelegationSkillTestHooks {
  lstat?(filePath: string, fallback: () => Promise<Stats>): Promise<Stats>;
  onEvent(
    event:
      | "afterJournal"
      | "beforeRename"
      | "afterRename"
      | "afterHash"
      | "beforeCommit"
      | "afterCommit",
    paths: { destination: string; quarantine?: string },
  ): Promise<void> | void;
}

type TransactionOperation = "install" | "update" | "uninstall";

interface TransactionJournal {
  version: 1;
  id: string;
  operation: TransactionOperation;
  destination: string;
  quarantine: string;
  expectedDigest: string | null;
}

const JOURNAL_PATTERN = /^\.SKILL\.md\.([0-9a-f-]{36})\.journal$/u;

function transactionPaths(
  destination: string,
  id: string,
): {
  journal: string;
  quarantine: string;
  complete: string;
} {
  const directory = path.dirname(destination);
  return {
    journal: path.join(directory, `.SKILL.md.${id}.journal`),
    quarantine: path.join(directory, `.SKILL.md.${id}.quarantine`),
    complete: path.join(directory, `.SKILL.md.${id}.complete`),
  };
}

async function emit(
  hooks: DelegationSkillTestHooks | undefined,
  event: Parameters<DelegationSkillTestHooks["onEvent"]>[0],
  transaction: Pick<TransactionJournal, "destination" | "quarantine">,
): Promise<void> {
  await hooks?.onEvent(event, {
    destination: transaction.destination,
    quarantine: transaction.quarantine,
  });
}

function parseJournal(filePath: string, value: string): TransactionJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid Delegation Skill transaction journal: ${filePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Delegation Skill transaction journal: ${filePath}`);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "destination",
    "expectedDigest",
    "id",
    "operation",
    "quarantine",
    "version",
  ];
  const id = JOURNAL_PATTERN.exec(path.basename(filePath))?.[1];
  const operation = record.operation;
  const digestIsValid =
    operation === "install"
      ? record.expectedDigest === null
      : typeof record.expectedDigest === "string" &&
        knownManagedDigests().has(record.expectedDigest);
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    record.version !== 1 ||
    record.id !== id ||
    (operation !== "install" && operation !== "update" && operation !== "uninstall") ||
    typeof record.destination !== "string" ||
    typeof record.quarantine !== "string" ||
    !digestIsValid
  ) {
    throw new Error(`Invalid Delegation Skill transaction journal: ${filePath}`);
  }
  if (!id) throw new Error(`Invalid Delegation Skill transaction journal: ${filePath}`);
  const expectedPaths = transactionPaths(record.destination, id);
  if (record.quarantine !== expectedPaths.quarantine || filePath !== expectedPaths.journal) {
    throw new Error(`Invalid Delegation Skill transaction journal: ${filePath}`);
  }
  return record as unknown as TransactionJournal;
}

async function sameEntry(first: string, second: string): Promise<boolean> {
  try {
    const [firstStat, secondStat] = await Promise.all([lstat(first), lstat(second)]);
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function markTransactionComplete(
  home: string,
  transaction: TransactionJournal,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<void> {
  const transactionFiles = transactionPaths(transaction.destination, transaction.id);
  await validateDestinationPath(home, transactionFiles.journal, false, hooks);
  try {
    await link(transactionFiles.journal, transactionFiles.complete);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      !(await sameEntry(transactionFiles.journal, transactionFiles.complete))
    ) {
      throw error;
    }
  }
}

async function transactionIsComplete(transaction: TransactionJournal): Promise<boolean> {
  const files = transactionPaths(transaction.destination, transaction.id);
  const complete = await lstat(files.complete).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!complete) return false;
  if (!complete.isFile() || !(await sameEntry(files.journal, files.complete))) {
    throw new Error(`Invalid Delegation Skill transaction completion: ${files.complete}`);
  }
  return true;
}

async function beginTransaction(
  home: string,
  destination: string,
  operation: TransactionOperation,
  expectedDigest: string | null,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<TransactionJournal> {
  await validateDestinationPath(home, destination, true, hooks);
  const id = randomUUID();
  const files = transactionPaths(destination, id);
  const transaction: TransactionJournal = {
    version: 1,
    id,
    operation,
    destination,
    quarantine: files.quarantine,
    expectedDigest,
  };
  const handle = await open(files.journal, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(transaction)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await emit(hooks, "afterJournal", transaction);
  return transaction;
}

async function exactDigest(
  home: string,
  filePath: string,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<string | null> {
  await validateDestinationPath(home, filePath, false, hooks);
  const value = await readOptional(filePath);
  return value === null ? null : digest(value);
}

async function createCurrentExclusive(
  home: string,
  transaction: TransactionJournal,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<void> {
  await emit(hooks, "beforeCommit", transaction);
  await validateDestinationPath(home, transaction.destination, true, hooks);
  let handle;
  try {
    handle = await open(transaction.destination, "wx", 0o600);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "EEXIST" &&
      (await exactDigest(home, transaction.destination, hooks)) === CURRENT_DIGEST
    ) {
      return;
    }
    throw new Error(`Delegation Skill destination is occupied: ${transaction.destination}`, {
      cause: error,
    });
  }
  try {
    await handle.writeFile(CODEXHOST_DELEGATION_SKILL, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await emit(hooks, "afterCommit", transaction);
  await validateDestinationPath(home, transaction.destination, false, hooks);
  if ((await exactDigest(home, transaction.destination, hooks)) !== CURRENT_DIGEST) {
    throw new Error(`Delegation Skill verification failed: ${transaction.destination}`);
  }
}

async function moveToQuarantine(
  home: string,
  transaction: TransactionJournal,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<void> {
  await emit(hooks, "beforeRename", transaction);
  await validateDestinationPath(home, transaction.destination, false, hooks);
  await rename(transaction.destination, transaction.quarantine);
  await emit(hooks, "afterRename", transaction);
  await validateDestinationPath(home, transaction.quarantine, false, hooks);
}

async function restoreForeignQuarantine(
  home: string,
  transaction: TransactionJournal,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<never> {
  await validateDestinationPath(home, transaction.quarantine, false, hooks);
  const destinationDigest = await exactDigest(home, transaction.destination, hooks);
  if (destinationDigest === null) {
    await emit(hooks, "beforeCommit", transaction);
    await validateDestinationPath(home, transaction.destination, true, hooks);
    try {
      await link(transaction.quarantine, transaction.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Delegation Skill destination is occupied: ${transaction.destination}`, {
          cause: error,
        });
      }
      throw error;
    }
    await emit(hooks, "afterCommit", transaction);
    await validateDestinationPath(home, transaction.destination, false, hooks);
    throw new Error(
      `Delegation Skill transaction contains foreign content: ${transaction.quarantine}`,
    );
  }
  if (await sameEntry(transaction.quarantine, transaction.destination)) {
    throw new Error(
      `Delegation Skill transaction contains foreign content: ${transaction.quarantine}`,
    );
  }
  throw new Error(`Delegation Skill destination is occupied: ${transaction.destination}`);
}

async function recoverTransaction(
  home: string,
  transaction: TransactionJournal,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<void> {
  if (await transactionIsComplete(transaction)) return;
  let quarantineDigest = await exactDigest(home, transaction.quarantine, hooks);
  if (quarantineDigest !== null) {
    await emit(hooks, "afterHash", transaction);
    quarantineDigest = await exactDigest(home, transaction.quarantine, hooks);
    if (quarantineDigest !== transaction.expectedDigest) {
      await restoreForeignQuarantine(home, transaction, hooks);
    }
    if (transaction.operation === "uninstall") {
      await markTransactionComplete(home, transaction, hooks);
      return;
    }
    if (transaction.operation === "update") {
      const destinationDigest = await exactDigest(home, transaction.destination, hooks);
      if (destinationDigest === null) {
        await createCurrentExclusive(home, transaction, hooks);
      } else if (destinationDigest !== CURRENT_DIGEST) {
        throw new Error(`Delegation Skill destination is occupied: ${transaction.destination}`);
      }
      await markTransactionComplete(home, transaction, hooks);
      return;
    }
    throw new Error(`Invalid Delegation Skill install quarantine: ${transaction.quarantine}`);
  }

  const destinationDigest = await exactDigest(home, transaction.destination, hooks);
  if (transaction.operation === "install") {
    if (destinationDigest === null) await createCurrentExclusive(home, transaction, hooks);
    else if (destinationDigest !== CURRENT_DIGEST)
      throw new Error(`Delegation Skill destination is occupied: ${transaction.destination}`);
    await markTransactionComplete(home, transaction, hooks);
    return;
  }
  if (destinationDigest === transaction.expectedDigest) {
    await moveToQuarantine(home, transaction, hooks);
    await recoverTransaction(home, transaction, hooks);
    return;
  }
  if (
    (transaction.operation === "update" && destinationDigest === CURRENT_DIGEST) ||
    (transaction.operation === "uninstall" && destinationDigest === null)
  ) {
    await markTransactionComplete(home, transaction, hooks);
    return;
  }
  throw new Error(`Delegation Skill transaction lost ownership: ${transaction.destination}`);
}

async function recoverTransactions(
  home: string,
  destination: string,
  hooks: DelegationSkillTestHooks | undefined,
): Promise<void> {
  await validateDestinationPath(home, destination, false, hooks);
  const directory = path.dirname(destination);
  const names = await readdir(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of names.sort()) {
    if (!JOURNAL_PATTERN.test(name)) continue;
    const journalPath = path.join(directory, name);
    await validateDestinationPath(home, journalPath, false, hooks);
    const transaction = parseJournal(journalPath, await readFile(journalPath, "utf8"));
    if (transaction.destination !== destination) {
      throw new Error(`Invalid Delegation Skill transaction journal: ${journalPath}`);
    }
    await recoverTransaction(home, transaction, hooks);
  }
}

async function installDelegationSkillsInternal(
  input: DelegationSkillLifecycleInput = {},
  _hooks?: DelegationSkillTestHooks,
): Promise<DelegationSkillInstallResult[]> {
  const home = await canonicalHome(input.homeDirectory ?? os.homedir());
  const destinationPaths = destinations(home);
  const knownDigests = knownManagedDigests();
  const results: DelegationSkillInstallResult[] = [];
  for (const destination of destinationPaths) {
    await recoverTransactions(home, destination, _hooks);
    const classified = await classifyDelegationSkill(home, destination, knownDigests, _hooks);
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
      const transaction = await beginTransaction(
        home,
        destination,
        "update",
        classified.digest,
        _hooks,
      );
      await recoverTransaction(home, transaction, _hooks);
      results.push({
        path: destination,
        status: "updated",
        version: SKILL_VERSION,
        digest: CURRENT_DIGEST,
      });
      continue;
    }
    const transaction = await beginTransaction(home, destination, "install", null, _hooks);
    await recoverTransaction(home, transaction, _hooks);
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
    if (source !== CODEXHOST_DELEGATION_SKILL) {
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

async function inspectDelegationSkillsInternal(
  input: DelegationSkillLifecycleInput = {},
  _hooks?: DelegationSkillTestHooks,
): Promise<DelegationSkillStatusResult[]> {
  const home = await canonicalHome(input.homeDirectory ?? os.homedir());
  const knownDigests = knownManagedDigests();
  const results: DelegationSkillStatusResult[] = [];
  for (const destination of destinations(home)) {
    await recoverTransactions(home, destination, _hooks);
    results.push(await classifyDelegationSkill(home, destination, knownDigests, _hooks));
  }
  return results;
}

async function uninstallDelegationSkillsInternal(
  input: DelegationSkillLifecycleInput = {},
  _hooks?: DelegationSkillTestHooks,
): Promise<DelegationSkillUninstallResult[]> {
  const home = await canonicalHome(input.homeDirectory ?? os.homedir());
  const knownDigests = knownManagedDigests();
  const results: DelegationSkillUninstallResult[] = [];
  for (const destination of destinations(home)) {
    await recoverTransactions(home, destination, _hooks);
    const classified = await classifyDelegationSkill(home, destination, knownDigests, _hooks);
    if (classified.status !== "current" && classified.status !== "managed-legacy") {
      results.push(classified);
      continue;
    }
    const transaction = await beginTransaction(
      home,
      destination,
      "uninstall",
      classified.digest,
      _hooks,
    );
    await recoverTransaction(home, transaction, _hooks);
    results.push({ ...classified, status: "removed" });
  }
  return results;
}

export function installDelegationSkills(
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillInstallResult[]> {
  return installDelegationSkillsInternal(input);
}

export function inspectDelegationSkills(
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillStatusResult[]> {
  return inspectDelegationSkillsInternal(input);
}

export function uninstallDelegationSkills(
  input: DelegationSkillLifecycleInput = {},
): Promise<DelegationSkillUninstallResult[]> {
  return uninstallDelegationSkillsInternal(input);
}

// Internal source-level seam; package consumers only receive exports from index.ts.
export function createDelegationSkillLifecycleForTest(hooks: DelegationSkillTestHooks): {
  install(input?: DelegationSkillLifecycleInput): Promise<DelegationSkillInstallResult[]>;
  inspect(input?: DelegationSkillLifecycleInput): Promise<DelegationSkillStatusResult[]>;
  uninstall(input?: DelegationSkillLifecycleInput): Promise<DelegationSkillUninstallResult[]>;
} {
  return {
    install: (input) => installDelegationSkillsInternal(input, hooks),
    inspect: (input) => inspectDelegationSkillsInternal(input, hooks),
    uninstall: (input) => uninstallDelegationSkillsInternal(input, hooks),
  };
}
