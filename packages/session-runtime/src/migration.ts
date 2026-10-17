import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  acquireLegacySourceLock,
  canonicalSessionPath,
  type SessionOwnership,
} from "./ownership-lock.js";
import { emptyLocalOrganization, LOCAL_ORGANIZATION_FILE } from "./organization-store.js";
import {
  migrateLegacyOrganization,
  objectValue,
  validateLegacyIndex,
  validateLegacyJournal,
} from "./migration-validation.js";

const ROLLED_BACK = "migration-rolled-back-v1.json",
  SOURCE_SEAL = "source-migrated-v1.json";
const COMMIT = "migration-commit-v1.json",
  PENDING = "migration-pending-v1.json",
  MUTATED = "migration-mutated-v1.json";
export interface SourceActivity {
  activeTurns: number;
  queuedPrompts: number;
  interactions: number;
  submissions: number;
  uploads: number;
}
export interface MigrationCommit {
  version: 1;
  state: "committed";
  sourceKind: "web-codex";
  sourceSchema: "legacy-index-v1-dsh-v4";
  targetSchema: 1;
  registrationId: string;
  sourceDataRoot: string;
  nativeHome: string;
  digest: string;
  sessionIds: string[];
  excludedDraftIds: string[];
  excludedExternalReferences: string[];
  excludedReferenceWorkspaceIds: string[];
  backup: string;
}
function atomicJson(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
function strictBytes(file: string): Buffer {
  if (lstatSync(file).isSymbolicLink() || canonicalSessionPath(file) !== file)
    throw new Error(`migration-symlink-invalid: ${file}`);
  return readFileSync(file);
}
function digestFiles(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    hash.update(name).update("\0").update(bytes).update("\0");
  return hash.digest("hex");
}
function readCommit(root: string, file = COMMIT): MigrationCommit {
  const record = objectValue(JSON.parse(strictBytes(join(root, file)).toString()), "commit");
  if (
    record.version !== 1 ||
    record.state !== "committed" ||
    record.sourceKind !== "web-codex" ||
    record.sourceSchema !== "legacy-index-v1-dsh-v4" ||
    record.targetSchema !== 1 ||
    typeof record.registrationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.registrationId) ||
    typeof record.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    typeof record.sourceDataRoot !== "string" ||
    typeof record.nativeHome !== "string" ||
    typeof record.backup !== "string" ||
    !/^migration-backup-[a-f0-9-]+$/.test(record.backup)
  )
    throw new Error("migration-commit-invalid");
  if (
    !isAbsolute(record.sourceDataRoot) ||
    !isAbsolute(record.nativeHome) ||
    canonicalSessionPath(record.sourceDataRoot) !== record.sourceDataRoot ||
    canonicalSessionPath(record.nativeHome) !== record.nativeHome ||
    createHash("sha256")
      .update(`${record.sourceDataRoot}\0web-codex\0${record.nativeHome}`)
      .digest("hex") !== record.registrationId
  )
    throw new Error("migration-commit-invalid");
  for (const key of [
    "sessionIds",
    "excludedDraftIds",
    "excludedExternalReferences",
    "excludedReferenceWorkspaceIds",
  ])
    if (
      !Array.isArray(record[key]) ||
      (record[key] as unknown[]).some((id) => typeof id !== "string")
    )
      throw new Error("migration-commit-invalid");
  return record as unknown as MigrationCommit;
}
function validateInstalledCommit(root: string, home: string): MigrationCommit {
  const commit = readCommit(root);
  if (commit.nativeHome !== home) throw new Error("migration-owner-conflict");
  const index = objectValue(
    JSON.parse(strictBytes(join(root, "sessions", "index.json")).toString()),
    "installed index",
  );
  for (const id of commit.sessionIds) {
    if (objectValue(index[id], "installed metadata").sessionId !== id)
      throw new Error("migration-installed-invalid");
    for (const name of ["events.jsonl", "projections.json"])
      if (
        existsSync(join(root, commit.backup, "sessions", id, name)) &&
        !existsSync(join(root, "sessions", id, name))
      )
        throw new Error("migration-installed-invalid");
  }
  if (!existsSync(join(root, LOCAL_ORGANIZATION_FILE)))
    throw new Error("migration-installed-invalid");
  return commit;
}
function validatePending(root: string): {
  version: 1;
  kind?: "rollback";
  stage: string;
  backup: string;
  sourceDataRoot: string;
  registrationId: string;
} {
  const record = objectValue(JSON.parse(strictBytes(join(root, PENDING)).toString()), "pending");
  if (
    record.version !== 1 ||
    record.root !== root ||
    typeof record.sourceDataRoot !== "string" ||
    !isAbsolute(record.sourceDataRoot) ||
    typeof record.registrationId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.registrationId) ||
    (record.kind !== undefined && record.kind !== "rollback") ||
    typeof record.stage !== "string" ||
    !/^migration-stage-[a-f0-9-]+$/.test(record.stage) ||
    typeof record.backup !== "string" ||
    !/^migration-backup-[a-f0-9-]+$/.test(record.backup)
  )
    throw new Error("migration-pending-invalid");
  return record as {
    version: 1;
    kind?: "rollback";
    stage: string;
    backup: string;
    sourceDataRoot: string;
    registrationId: string;
  };
}
function setSourceSeal(root: string, sourceDataRoot: string, registrationId: string): void {
  const file = join(sourceDataRoot, "codex-sessions", SOURCE_SEAL);
  if (existsSync(file)) {
    const previous = objectValue(JSON.parse(strictBytes(file).toString()), "source seal");
    if (
      previous.version !== 1 ||
      previous.targetRoot !== root ||
      previous.registrationId !== registrationId
    )
      throw new Error("migration-source-sealed-elsewhere");
    return;
  }
  atomicJson(file, { version: 1, targetRoot: root, registrationId });
}
function clearSourceSeal(root: string, sourceDataRoot: string, registrationId: string): void {
  const file = join(sourceDataRoot, "codex-sessions", SOURCE_SEAL);
  if (!existsSync(file)) return;
  const previous = objectValue(JSON.parse(strictBytes(file).toString()), "source seal");
  if (
    previous.version !== 1 ||
    previous.targetRoot !== root ||
    previous.registrationId !== registrationId
  )
    throw new Error("migration-source-sealed-elsewhere");
  rmSync(file);
}

/** Call under ownership before constructing runtime: uncommitted imports are never exposed. */
export function recoverSessionMigration(ownership: SessionOwnership): "ready" | "rolled-back" {
  const root = ownership.root;
  if (!existsSync(join(root, PENDING))) {
    if (existsSync(join(root, COMMIT))) {
      const commit = validateInstalledCommit(root, ownership.home);
      setSourceSeal(root, commit.sourceDataRoot, commit.registrationId);
      rmSync(join(root, ROLLED_BACK), { force: true });
      return "ready";
    }
    return existsSync(join(root, ROLLED_BACK)) ? "rolled-back" : "ready";
  }
  const pending = validatePending(root);
  if (
    canonicalSessionPath(pending.sourceDataRoot) !== pending.sourceDataRoot ||
    createHash("sha256")
      .update(`${pending.sourceDataRoot}\0web-codex\0${ownership.home}`)
      .digest("hex") !== pending.registrationId
  )
    throw new Error("migration-pending-invalid");
  if (existsSync(join(root, COMMIT))) readCommit(root);
  if (pending.kind === "rollback") {
    const previous = readCommit(root, existsSync(join(root, COMMIT)) ? COMMIT : ROLLED_BACK);
    atomicJson(join(root, ROLLED_BACK), previous);
    const config = join(root, "service-config-v1.json");
    if (existsSync(config))
      renameSync(config, join(root, pending.backup, "service-config-v1.json"));
  }
  if (pending.kind === "rollback" || !existsSync(join(root, COMMIT))) {
    rmSync(join(root, "sessions"), { recursive: true, force: true });
    rmSync(join(root, LOCAL_ORGANIZATION_FILE), { force: true });
    if (pending.kind === "rollback") rmSync(join(root, COMMIT), { force: true });
    clearSourceSeal(root, pending.sourceDataRoot, pending.registrationId);
  } else {
    validateInstalledCommit(root, ownership.home);
    setSourceSeal(root, pending.sourceDataRoot, pending.registrationId);
    rmSync(join(root, ROLLED_BACK), { force: true });
  }
  rmSync(join(root, pending.stage), { recursive: true, force: true });
  rmSync(join(root, PENDING), { force: true });
  return pending.kind === "rollback" ? "rolled-back" : "ready";
}

/** A single explicit legacy source; no credentials, native history or attachment bytes are read. */
export async function migrateLegacyWebSource(options: {
  sourceDataRoot: string;
  targetRoot: string;
  codexHome: string;
  legacyWriterStopped: boolean;
  activity?: SourceActivity;
  ownership: SessionOwnership;
  /** Fault injection for transaction tests, never used by production composition. */
  beforeCommit?: () => void;
}): Promise<MigrationCommit> {
  if (!options.legacyWriterStopped) throw new Error("migration-quiescence-unconfirmed");
  if (
    options.activity &&
    Object.values(options.activity).some((value) => !Number.isFinite(value) || value !== 0)
  )
    throw new Error("migration-source-active");
  const sourceDataRoot = canonicalSessionPath(options.sourceDataRoot),
    sourceRoot = join(sourceDataRoot, "codex-sessions");
  if (canonicalSessionPath(sourceRoot) !== sourceRoot) throw new Error("migration-symlink-invalid");
  const root = canonicalSessionPath(options.targetRoot),
    home = canonicalSessionPath(options.codexHome);
  if (root !== options.ownership.root || home !== options.ownership.home || sourceRoot === root)
    throw new Error("migration-owner-conflict");
  const releaseSource = await acquireLegacySourceLock(sourceRoot);
  try {
    recoverSessionMigration(options.ownership);
    const registrationId = createHash("sha256")
      .update(`${sourceDataRoot}\0web-codex\0${home}`)
      .digest("hex");
    if (
      existsSync(join(root, ROLLED_BACK)) &&
      readCommit(root, ROLLED_BACK).registrationId !== registrationId
    )
      throw new Error("migration-source-conflict");
    if (existsSync(join(root, COMMIT))) {
      const previous = readCommit(root);
      if (
        previous.version !== 1 ||
        previous.registrationId !== registrationId ||
        previous.nativeHome !== home
      )
        throw new Error("migration-source-conflict");
      return previous;
    }
    if (existsSync(join(root, "sessions")) || existsSync(join(root, LOCAL_ORGANIZATION_FILE)))
      throw new Error("migration-target-conflict");
    const files = new Map<string, Buffer>(),
      indexBytes = strictBytes(join(sourceRoot, "sessions", "index.json"));
    files.set("sessions/index.json", indexBytes);
    const { index, excludedDraftIds } = validateLegacyIndex(
      JSON.parse(indexBytes.toString()),
      home,
    );
    const sessionIds = Object.keys(index);
    for (const id of sessionIds) {
      const directory = join(sourceRoot, "sessions", id);
      if (!existsSync(directory)) {
        const meta = objectValue(index[id], id);
        // Only empty native sessions or an explicitly pending lazy import may lack journals.
        if (
          meta.blank === true ||
          (typeof meta.nativeSessionId === "string" &&
            meta.backfill === "pending" &&
            Object.keys(objectValue(meta.checkpoints ?? {}, "checkpoints")).length === 0)
        )
          continue;
        throw new Error(`migration-journal-missing: ${id}`);
      }
      if (lstatSync(directory).isSymbolicLink()) throw new Error("migration-symlink-invalid");
      const metadata = objectValue(index[id], id);
      if (
        !existsSync(join(directory, "events.jsonl")) &&
        metadata.blank !== true &&
        !(typeof metadata.nativeSessionId === "string" && metadata.backfill === "pending")
      )
        throw new Error(`migration-journal-missing: ${id}`);
      for (const name of readdirSync(directory)) {
        if (name === "harness.jsonl") continue; // Debug output remains only at the preserved source.
        if (!["events.jsonl", "projections.json"].includes(name))
          throw new Error(`migration-schema-unsupported: ${id}/${name}`);
        const bytes = strictBytes(join(directory, name));
        if (name === "events.jsonl") validateLegacyJournal(bytes, id);
        else objectValue(JSON.parse(bytes.toString()), "projections");
        files.set(`sessions/${id}/${name}`, bytes);
      }
    }
    // Any unexplained session directory is a dangling identity, not data to silently drop.
    for (const name of readdirSync(join(sourceRoot, "sessions"))) {
      if (name === "index.json" || sessionIds.includes(name) || excludedDraftIds.includes(name))
        continue;
      throw new Error(`migration-session-reference-invalid: ${name}`);
    }
    const workspacePath = join(sourceDataRoot, "workspaces.json");
    const organization = existsSync(workspacePath)
      ? (() => {
          const bytes = strictBytes(workspacePath);
          files.set("legacy-workspaces.json", bytes);
          return migrateLegacyOrganization(JSON.parse(bytes.toString()), new Set(sessionIds));
        })()
      : {
          state: emptyLocalOrganization(),
          excludedExternalReferences: [],
          excludedReferenceWorkspaceIds: [],
        };
    const digest = digestFiles(files),
      token = randomUUID(),
      stage = `migration-stage-${token}`,
      backup = `migration-backup-${token}`;
    const inventory = () =>
      readdirSync(join(sourceRoot, "sessions"))
        .sort()
        .map((name) => {
          const entry = join(sourceRoot, "sessions", name);
          return [name, lstatSync(entry).isDirectory() ? readdirSync(entry).sort() : []];
        });
    const originalInventory = JSON.stringify(inventory());
    const assertUnchanged = () => {
      const reread = new Map<string, Buffer>();
      for (const name of files.keys())
        reread.set(
          name,
          strictBytes(name === "legacy-workspaces.json" ? workspacePath : join(sourceRoot, name)),
        );
      if (digestFiles(reread) !== digest || JSON.stringify(inventory()) !== originalInventory)
        throw new Error("migration-source-changed");
    };
    // Capture original bytes first, then stage the compatible recovery representation.
    for (const [name, bytes] of files) {
      const file = join(root, backup, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { mode: 0o600 });
    }
    for (const [name, bytes] of files) {
      if (name === "legacy-workspaces.json" || name === "sessions/index.json") continue;
      const file = join(root, stage, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes, { mode: 0o600 });
    }
    atomicJson(join(root, stage, "sessions", "index.json"), index);
    atomicJson(join(root, stage, LOCAL_ORGANIZATION_FILE), organization.state);
    // Re-read all original business bytes while source lock is held; old binaries cannot be
    // restrained by this lock, which is why explicit stopped/quiescent confirmation is required.
    assertUnchanged();
    atomicJson(join(root, PENDING), {
      version: 1,
      root,
      stage,
      backup,
      sourceDataRoot,
      registrationId,
    });
    try {
      // Seal before commit while holding the source lock. A crash conservatively blocks
      // the new standalone writer until target recovery decides commit or abort.
      setSourceSeal(root, sourceDataRoot, registrationId);
      renameSync(join(root, stage, "sessions"), join(root, "sessions"));
      renameSync(join(root, stage, LOCAL_ORGANIZATION_FILE), join(root, LOCAL_ORGANIZATION_FILE));
      options.beforeCommit?.();
      assertUnchanged();
      const commit: MigrationCommit = {
        version: 1,
        state: "committed",
        sourceKind: "web-codex",
        sourceSchema: "legacy-index-v1-dsh-v4",
        targetSchema: 1,
        registrationId,
        sourceDataRoot,
        nativeHome: home,
        digest,
        sessionIds,
        excludedDraftIds,
        excludedExternalReferences: organization.excludedExternalReferences,
        excludedReferenceWorkspaceIds: organization.excludedReferenceWorkspaceIds,
        backup,
      };
      atomicJson(join(root, COMMIT), commit);
      recoverSessionMigration(options.ownership);
      return commit;
    } catch (error) {
      recoverSessionMigration(options.ownership);
      throw error;
    }
  } finally {
    await releaseSource();
  }
}

/** Explicit stopped-owner recovery only; attempted new writes conservatively prevent rollback. */
export function rollbackSessionMigration(
  ownership: SessionOwnership,
  nativeExitConfirmed: boolean,
  afterRemove?: (step: "sessions" | "organization") => void,
): void {
  if (!nativeExitConfirmed) throw new Error("release-unconfirmed");
  const root = ownership.root;
  if (existsSync(join(root, MUTATED))) throw new Error("migration-rollback-has-mutations");
  if (!existsSync(join(root, COMMIT))) throw new Error("migration-not-committed");
  const commit = readCommit(root);
  if (commit.nativeHome !== ownership.home) throw new Error("migration-owner-conflict");
  // Source and backup remain untouched. Remove commit last, so a crash never makes a target
  // without commit appear to be an ordinary fresh owner profile.
  atomicJson(join(root, PENDING), {
    version: 1,
    root,
    kind: "rollback",
    stage: `migration-stage-${randomUUID()}`,
    backup: commit.backup,
    sourceDataRoot: commit.sourceDataRoot,
    registrationId: commit.registrationId,
  });
  atomicJson(join(root, ROLLED_BACK), commit);
  const config = join(root, "service-config-v1.json");
  if (existsSync(config)) renameSync(config, join(root, commit.backup, "service-config-v1.json"));
  rmSync(join(root, "sessions"), { recursive: true, force: true });
  afterRemove?.("sessions");
  rmSync(join(root, LOCAL_ORGANIZATION_FILE), { force: true });
  afterRemove?.("organization");
  rmSync(join(root, COMMIT));
  recoverSessionMigration(ownership);
}
