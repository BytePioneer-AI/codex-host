import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, relative } from "node:path";

export function canonicalSessionPath(value: string): string {
  const absolute = resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : join(canonicalSessionPath(parent), relative(parent, absolute));
}

export interface NativeExitProof {
  pid: number;
  generation: string;
  ownerRoot: string;
}
async function lockFile(
  file: string,
  instanceId: string,
  ownerRoot?: string,
  generation?: string,
  proof?: NativeExitProof,
): Promise<() => Promise<void>> {
  mkdirSync(dirname(file), { recursive: true });
  const acquire = () => open(file, "wx", 0o600);
  let handle;
  try {
    handle = await acquire();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale inspection/removal. Two contenders must not both inspect an old
    // identity and then let the second remove the first contender's new live lock.
    const reapPath = `${file}.reap`;
    let reap;
    try {
      reap = await open(reapPath, "wx", 0o600);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `source-recovery-in-progress: ${reapPath}; stop all source owners and confirm native exit before removing this recovery guard`,
        );
      throw failure;
    }
    try {
      await reap.writeFile(
        JSON.stringify({
          version: 1,
          pid: process.pid,
          instanceId,
          ownerRoot,
          startedAt: new Date().toISOString(),
        }),
      );
      await reap.sync();
      // Never steal a live PID's lock, including unknown process identities.
      let owner: { pid?: number; ownerRoot?: string; generation?: string };
      try {
        owner = JSON.parse(await readFile(file, "utf8")) as {
          pid?: number;
          ownerRoot?: string;
          generation?: string;
        };
      } catch {
        throw new Error(`source-owner-unknown: ${file}`);
      }
      if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0)
        throw new Error(`source-owner-unknown: ${file}`);
      try {
        process.kill(owner.pid, 0);
        throw new Error(`source-owner-live: ${file}`);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
      }
      if (
        ownerRoot !== undefined &&
        (!proof ||
          !owner.generation ||
          proof.pid !== owner.pid ||
          proof.generation !== owner.generation ||
          proof.ownerRoot !== ownerRoot ||
          owner.ownerRoot !== ownerRoot)
      )
        throw new Error(`release-unconfirmed: ${file}`);
      await rm(file);
      handle = await acquire();
    } finally {
      await reap.close();
      await rm(reapPath);
    }
  }
  await handle.writeFile(
    JSON.stringify({
      version: 1,
      pid: process.pid,
      instanceId,
      executable: process.execPath,
      startedAt: new Date().toISOString(),
      ownerRoot,
      generation,
    }),
  );
  await handle.sync();
  return async () => {
    await handle.close();
    try {
      if (
        (JSON.parse(await readFile(file, "utf8")) as { instanceId?: string }).instanceId ===
        instanceId
      )
        await rm(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}

/** Compatible durable store. An attempted post-commit mutation disables automatic rollback. */
export class OwnedSessionDataStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }
  path(...parts: string[]): string {
    const target = resolve(this.root, ...parts);
    const local = relative(this.root, target);
    if (
      local === ".." ||
      local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(local)
    )
      throw new Error("source-path-invalid");
    return target;
  }
  readJson<T>(file: string, fallback: T): T {
    const target = this.path(file);
    return existsSync(target) ? (JSON.parse(readFileSync(target, "utf8")) as T) : fallback;
  }
  readLines<T>(file: string): T[] {
    const target = this.path(file);
    if (!existsSync(target)) return [];
    return readFileSync(target, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }
  private beforeWrite(): void {
    if (
      existsSync(this.path("migration-commit-v1.json")) &&
      !existsSync(this.path("migration-mutated-v1.json"))
    )
      this.atomic("migration-mutated-v1.json", { version: 1, at: new Date().toISOString() });
  }
  /** Composition config is not a Session mutation; never use this for business state. */
  writeConfiguration(file: "service-config-v1.json" | "source-v1.json", value: unknown): void {
    this.atomic(file, value);
  }
  private atomic(file: string, value: unknown): void {
    const target = this.path(file);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  }
  writeJson(file: string, value: unknown): void {
    this.beforeWrite();
    this.atomic(file, value);
  }
  appendLine(file: string, value: unknown): void {
    this.beforeWrite();
    const target = this.path(file);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
  writeLines(file: string, values: readonly unknown[]): void {
    this.beforeWrite();
    const target = this.path(file);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, values.map((value) => `${JSON.stringify(value)}\n`).join(""), {
      mode: 0o600,
    });
    renameSync(temp, target);
  }
}

export interface SessionOwnership {
  root: string;
  home: string;
  data: OwnedSessionDataStore;
  release(): Promise<void>;
}

/** Locks both profile storage and native home; shared and standalone use the same admission. */
export async function acquireSourceOwnerLock(options: {
  root: string;
  home: string;
  instanceId?: string;
  ownerGeneration?: string;
  nativeExitProof?: NativeExitProof;
}): Promise<SessionOwnership> {
  if (!isAbsolute(options.root) || !isAbsolute(options.home))
    throw new Error("source-path-invalid");
  const root = canonicalSessionPath(options.root),
    home = canonicalSessionPath(options.home);
  if (existsSync(join(root, "source-migrated-v1.json")))
    throw new Error("source-migrated: use the shared target owner or explicit rollback");
  const id = options.instanceId ?? randomUUID();
  const releaseRoot = await lockFile(join(root, "source-owner-v1.lock"), id);
  try {
    if (existsSync(join(root, "source-migrated-v1.json")))
      throw new Error("source-migrated: use the shared target owner or explicit rollback");
    const descriptorPath = join(root, "source-v1.json");
    if (existsSync(descriptorPath)) {
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
        version?: number;
        home?: string;
        format?: string;
      };
      if (descriptor.version !== 1 || descriptor.format !== "sessions-v1")
        throw new Error("source-schema-unsupported");
      if (descriptor.home !== home) throw new Error("source-home-conflict");
    }
    const indexPath = join(root, "sessions", "index.json");
    if (existsSync(indexPath)) {
      const index: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
      if (!index || typeof index !== "object" || Array.isArray(index))
        throw new Error("source-schema-unsupported");
      for (const metadata of Object.values(index)) {
        if (!metadata || typeof metadata !== "object") throw new Error("source-schema-unsupported");
        const ref = (
          metadata as { nativeRef?: { harnessId?: unknown; locator?: { codexHome?: unknown } } }
        ).nativeRef;
        if (ref !== undefined && (ref?.harnessId !== "codex" || ref?.locator?.codexHome !== home))
          throw new Error("source-home-conflict");
      }
    }
    const releaseHome = await lockFile(
      join(home, ".codexhost-source-owner-v1.lock"),
      id,
      root,
      options.ownerGeneration,
      options.nativeExitProof,
    );
    const data = new OwnedSessionDataStore(root);
    try {
      if (!existsSync(descriptorPath))
        data.writeConfiguration("source-v1.json", { version: 1, home, format: "sessions-v1" });
    } catch (error) {
      await releaseHome();
      throw error;
    }
    let released = false;
    return {
      root,
      home,
      data,
      release: async () => {
        if (released) return;
        await releaseHome();
        await releaseRoot();
        released = true;
      },
    };
  } catch (error) {
    await releaseRoot();
    throw error;
  }
}

/** The migration holds only the source profile lock: the target already owns the home lock. */
export async function acquireLegacySourceLock(root: string): Promise<() => Promise<void>> {
  return lockFile(join(root, "source-owner-v1.lock"), randomUUID());
}
