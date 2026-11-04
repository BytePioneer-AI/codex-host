/**
 * Web access credentials stored in the Web data directory.
 *
 * `auth.json` holds the plaintext local token, which only the local-access check accepts.
 * `access-tokens.json` holds named tokens and their SHA-256 hashes. Several Web processes may share one
 * data directory, so the file is the source of truth: every check and mutation re-reads it when it
 * changed, and a timer notices removals for connections that make no further requests.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, statSync } from "node:fs";

import type { WebAccessToken } from "@codexhost/shared-contracts";
import { WEB_ACCESS_TOKEN_NAME_MAX } from "@codexhost/shared-contracts";

import type { DataDir } from "./store.ts";
import { RpcError } from "./transport.ts";

const LOCAL_FILE = "auth.json";
const TOKENS_FILE = "access-tokens.json";
/** Kept apart from the tokens so a stale usage write can never restore a deleted token. */
const USAGE_FILE = "access-token-usage.json";
const SECRET_MODE = 0o600;
const USAGE_WRITE_INTERVAL_MS = 60_000;
const REMOVAL_CHECK_INTERVAL_MS = 5_000;

interface StoredToken {
  id: string;
  name: string;
  hash: string;
  secret?: string;
  createdAt: number;
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStoredToken(value: unknown): value is StoredToken {
  const entry = value as Partial<StoredToken> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.hash === "string" &&
    (entry.secret === undefined || typeof entry.secret === "string") &&
    typeof entry.createdAt === "number"
  );
}

export class AccessTokenStore {
  readonly localToken: string;
  private readonly localHash: Buffer;
  private tokens = new Map<string, StoredToken>();
  private idByHash = new Map<string, string>();
  private signature: string | undefined;
  private readonly usageWrites = new Map<string, number>();
  private readonly removalListeners = new Set<(id: string) => void>();
  private readonly timer: NodeJS.Timeout;

  /**
   * @param data - Web data directory.
   * @param options.token - explicit local token; replaces the stored one.
   */
  constructor(
    private readonly data: DataDir,
    options: { token?: string } = {},
  ) {
    const stored = data.readJson<{ token?: string }>(LOCAL_FILE, {});
    let token = options.token ?? stored.token;
    if (token === undefined || token.length < 16) token = randomBytes(24).toString("base64url");
    if (token === stored.token) chmodSync(data.path(LOCAL_FILE), SECRET_MODE);
    else data.writeJson(LOCAL_FILE, { token }, { mode: SECRET_MODE });
    this.localToken = token;
    this.localHash = createHash("sha256").update(token).digest();
    this.load();
    this.timer = setInterval(() => {
      this.sync();
    }, REMOVAL_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Observe token removal, whichever process performed it. */
  onRemoved(listener: (id: string) => void): void {
    this.removalListeners.add(listener);
  }

  isLocalToken(candidate: string): boolean {
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), this.localHash);
  }

  /** @returns the id of the named token matching this value, recording its use. */
  resolve(candidate: string): string | undefined {
    this.sync();
    const id = this.idByHash.get(hashOf(candidate));
    if (id !== undefined) this.recordUse(id);
    return id;
  }

  has(id: string): boolean {
    this.sync();
    return this.tokens.has(id);
  }

  list(): WebAccessToken[] {
    this.sync();
    const usage = this.readUsage();
    return [...this.tokens.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((token) => ({
        id: token.id,
        name: token.name,
        secret: token.secret ?? null,
        createdAt: token.createdAt,
        lastUsedAt: usage[token.id] ?? null,
      }));
  }

  /** @returns the new entry and its plaintext, also available from the local token list. */
  create(rawName: string): { token: WebAccessToken; secret: string } {
    this.sync();
    const name = rawName.trim();
    if (name.length === 0 || [...name].length > WEB_ACCESS_TOKEN_NAME_MAX) {
      throw new RpcError(
        "auth/invalid-token-name",
        `A token name must have 1 to ${String(WEB_ACCESS_TOKEN_NAME_MAX)} characters`,
        {},
      );
    }
    if ([...this.tokens.values()].some((token) => token.name === name)) {
      throw new RpcError("auth/duplicate-token-name", "A token with this name already exists", {});
    }
    const secret = randomBytes(32).toString("base64url");
    const stored: StoredToken = {
      id: randomUUID(),
      name,
      hash: hashOf(secret),
      secret,
      createdAt: Date.now(),
    };
    this.save([...this.tokens.values(), stored]);
    this.load();
    return {
      secret,
      token: { id: stored.id, name, secret, createdAt: stored.createdAt, lastUsedAt: null },
    };
  }

  /** @returns whether the token existed. Removal listeners run before this returns. */
  delete(id: string): boolean {
    this.sync();
    if (!this.tokens.has(id)) return false;
    this.save([...this.tokens.values()].filter((token) => token.id !== id));
    this.sync();
    return true;
  }

  /** Adopt another process's changes and report any token that disappeared. */
  private sync(): void {
    if (this.fileSignature() === this.signature) return;
    const previous = [...this.tokens.keys()];
    this.load();
    for (const id of previous) {
      if (this.tokens.has(id)) continue;
      this.usageWrites.delete(id);
      for (const listener of this.removalListeners) listener(id);
    }
  }

  private load(): void {
    this.signature = this.fileSignature();
    const stored = this.data.readJson<{ tokens?: unknown }>(TOKENS_FILE, {}).tokens;
    const tokens = Array.isArray(stored) ? stored.filter(isStoredToken) : [];
    this.tokens = new Map(tokens.map((token) => [token.id, token]));
    this.idByHash = new Map(tokens.map((token) => [token.hash, token.id]));
  }

  /** Callers sync first, so the written list cannot restore a token another process deleted. */
  private save(tokens: StoredToken[]): void {
    this.data.writeJson(TOKENS_FILE, { tokens }, { mode: SECRET_MODE });
  }

  /** Replacing the file changes its inode, which also covers same-millisecond rewrites. */
  private fileSignature(): string | undefined {
    try {
      const { ino, mtimeMs, size } = statSync(this.data.path(TOKENS_FILE));
      return `${String(ino)}:${String(mtimeMs)}:${String(size)}`;
    } catch {
      return undefined;
    }
  }

  private readUsage(): Record<string, number> {
    return this.data.readJson<Record<string, number>>(USAGE_FILE, {});
  }

  private recordUse(id: string): void {
    const now = Date.now();
    if (now - (this.usageWrites.get(id) ?? 0) < USAGE_WRITE_INTERVAL_MS) return;
    this.usageWrites.set(id, now);
    try {
      const usage = Object.fromEntries(
        Object.entries(this.readUsage()).filter(([known]) => this.tokens.has(known)),
      );
      this.data.writeJson(USAGE_FILE, { ...usage, [id]: now }, { mode: SECRET_MODE });
    } catch (error) {
      // Losing one timestamp must not fail the authenticated request.
      console.error("[auth] could not record token use", error);
    }
  }
}
