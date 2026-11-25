import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { jsonValueSchema } from "@codexhost/shared-contracts";

const persistedWorktreeSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
  })
  .strict();

const persistedPeerStartRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    requestId: z.string().min(1),
    parentThreadId: z.string().min(1),
    configHash: z.string().regex(/^[a-f0-9]{64}$/u),
    state: z.enum(["pending", "completed"]),
    worktree: persistedWorktreeSchema.optional(),
    result: jsonValueSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const persistedWorktreeOwnerSchema = z
  .object({
    formatVersion: z.literal(1),
    requestId: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
  })
  .strict();

export type PersistedPeerStartRecord = z.infer<typeof persistedPeerStartRecordSchema>;
export type WorktreeOwnerClaimResult = "claimed" | "owned" | "conflict";

export interface PeerStartIdempotencyStore {
  get(requestId: string): Promise<PersistedPeerStartRecord | undefined>;
  set(record: PersistedPeerStartRecord): Promise<void>;
  delete?(requestId: string): Promise<void>;
  claimWorktreeOwner?(
    target: { path: string; branch: string },
    requestId: string,
  ): Promise<WorktreeOwnerClaimResult>;
  getWorktreeOwner?(target: { path: string; branch: string }): Promise<string | undefined>;
  releaseWorktreeOwner?(target: { path: string; branch: string }, requestId: string): Promise<void>;
}

/**
 * Canonicalize a worktree path (which may not exist yet) by resolving its nearest existing
 * ancestor via `realpath` (falling back to `path.resolve`), re-appending remaining segments,
 * and normalizing case on Windows.
 */
export async function canonicalizeWorktreePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const trailing: string[] = [];
  let current = resolved;
  let canonicalBase: string;
  for (;;) {
    try {
      canonicalBase = await realpath(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        canonicalBase = resolved;
        break;
      }
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
  const combined = trailing.length > 0 ? path.join(canonicalBase, ...trailing) : canonicalBase;
  return process.platform === "win32" ? combined.toLowerCase() : combined;
}

function recordFileName(requestId: string): string {
  return `${createHash("sha256").update(requestId).digest("hex")}.json`;
}

function ownerFileName(canonicalPath: string, branch: string): string {
  return `${createHash("sha256").update(`${canonicalPath}\0${branch}`).digest("hex")}.json`;
}

/**
 * Durable write-ahead store for remote Peer `delegate start` requests keyed by `requestId`.
 * Persists `pending` -> planned `worktree` (with atomic hardlink-published exclusive `(path, branch)`
 * ownership) -> `completed` transitions so cold replays after restarts or mid-flight crashes recover
 * safely without leaving orphaned locks or adopting another caller's checkout.
 */
export class FilePeerStartIdempotencyStore implements PeerStartIdempotencyStore {
  constructor(private readonly directory: string) {}

  async #ownerKey(target: { path: string; branch: string }): Promise<{
    canonicalPath: string;
    ownerFile: string;
  }> {
    const canonicalPath = await canonicalizeWorktreePath(target.path);
    return {
      canonicalPath,
      ownerFile: path.join(
        this.directory,
        "worktree-owners",
        ownerFileName(canonicalPath, target.branch),
      ),
    };
  }

  async get(requestId: string): Promise<PersistedPeerStartRecord | undefined> {
    const filePath = path.join(this.directory, recordFileName(requestId));
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = persistedPeerStartRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.requestId !== requestId) return undefined;
    return parsed.data;
  }

  async set(record: PersistedPeerStartRecord): Promise<void> {
    const validated = persistedPeerStartRecordSchema.parse(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, recordFileName(validated.requestId));
    const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(validated), { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async delete(requestId: string): Promise<void> {
    const target = path.join(this.directory, recordFileName(requestId));
    await rm(target, { force: true });
  }

  async claimWorktreeOwner(
    target: { path: string; branch: string },
    requestId: string,
  ): Promise<WorktreeOwnerClaimResult> {
    const ownerDir = path.join(this.directory, "worktree-owners");
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    const { canonicalPath, ownerFile } = await this.#ownerKey(target);
    const temporary = `${ownerFile}.${randomBytes(8).toString("hex")}.tmp`;
    const payload = persistedWorktreeOwnerSchema.parse({
      formatVersion: 1,
      requestId,
      path: canonicalPath,
      branch: target.branch,
    });
    const serialized = JSON.stringify(payload);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Atomically publish via hardlink so ownerFile is never visible as empty or truncated JSON.
      await link(temporary, ownerFile);
      return "claimed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.getWorktreeOwner(target);
      return existing === requestId ? "owned" : "conflict";
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async getWorktreeOwner(target: { path: string; branch: string }): Promise<string | undefined> {
    const { ownerFile } = await this.#ownerKey(target);
    let raw: string;
    try {
      raw = await readFile(ownerFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const parsed = persistedWorktreeOwnerSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.requestId : undefined;
    } catch {
      return undefined;
    }
  }

  async releaseWorktreeOwner(
    target: { path: string; branch: string },
    requestId: string,
  ): Promise<void> {
    const { ownerFile } = await this.#ownerKey(target);
    const existing = await this.getWorktreeOwner(target);
    if (existing === requestId) {
      await rm(ownerFile, { force: true });
    }
  }
}
