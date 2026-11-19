/**
 * Web access credentials stored in the Web data directory.
 *
 * `auth.json` holds the local token, which only the local-access check accepts. `access-token.json`
 * holds the token other devices sign in with, created when it is first viewed. Several Web processes
 * may share one data directory, so the file is the source of truth: every check re-reads it when it
 * changed, and a timer notices replacement for connections that make no further requests.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, statSync } from "node:fs";

import type { DataDir } from "./store.ts";

const LOCAL_FILE = "auth.json";
const TOKEN_FILE = "access-token.json";
/** Kept apart from the token so a stale usage write can never restore a replaced token. */
const USAGE_FILE = "access-token-usage.json";
const SECRET_MODE = 0o600;
const USAGE_WRITE_INTERVAL_MS = 60_000;
const REPLACEMENT_CHECK_INTERVAL_MS = 5_000;

interface StoredToken {
  /** Owns this token's connections and push subscriptions; changes when the token is regenerated. */
  id: string;
  secret: string;
}

function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStoredToken(value: unknown): value is StoredToken {
  const entry = value as Partial<StoredToken> | null;
  return typeof entry?.id === "string" && typeof entry.secret === "string";
}

export class AccessTokenStore {
  readonly localToken: string;
  private readonly localHash: Buffer;
  private token: (StoredToken & { hash: string }) | undefined;
  private signature: string | undefined;
  private lastUsageWrite = 0;
  private readonly revocationListeners = new Set<(id: string) => void>();
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
    }, REPLACEMENT_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Observe a token being replaced or removed, whichever process did it. */
  onRevoked(listener: (id: string) => void): void {
    this.revocationListeners.add(listener);
  }

  isLocalToken(candidate: string): boolean {
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), this.localHash);
  }

  /** @returns the id of the access token when this value matches it, recording its use. */
  resolve(candidate: string): string | undefined {
    this.sync();
    if (this.token === undefined || hashOf(candidate) !== this.token.hash) return undefined;
    this.recordUse(this.token.id);
    return this.token.id;
  }

  has(id: string): boolean {
    this.sync();
    return this.token?.id === id;
  }

  /** @returns the access token, creating it on first use, and when another device last used it. */
  current(): { secret: string; lastUsedAt: number | null } {
    this.sync();
    if (this.token === undefined) {
      this.write();
      this.load();
    }
    const { id, secret } = this.token as StoredToken;
    return { secret, lastUsedAt: this.readUsage()[id] ?? null };
  }

  /** Replace the access token. Revocation listeners run before this returns. */
  regenerate(): { secret: string; lastUsedAt: number | null } {
    this.sync();
    this.write();
    this.sync();
    return this.current();
  }

  /** Adopt another process's change and report a token that is no longer current. */
  private sync(): void {
    if (this.fileSignature() === this.signature) return;
    const previous = this.token?.id;
    this.load();
    if (previous === undefined || previous === this.token?.id) return;
    this.lastUsageWrite = 0;
    for (const listener of this.revocationListeners) listener(previous);
  }

  private load(): void {
    this.signature = this.fileSignature();
    const stored = this.data.readJson<unknown>(TOKEN_FILE, undefined);
    this.token = isStoredToken(stored) ? { ...stored, hash: hashOf(stored.secret) } : undefined;
  }

  private write(): void {
    const token: StoredToken = { id: randomUUID(), secret: randomBytes(32).toString("base64url") };
    this.data.writeJson(TOKEN_FILE, token, { mode: SECRET_MODE });
  }

  /** Replacing the file changes its inode, which also covers same-millisecond rewrites. */
  private fileSignature(): string | undefined {
    try {
      const { ino, mtimeMs, size } = statSync(this.data.path(TOKEN_FILE));
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
    if (now - this.lastUsageWrite < USAGE_WRITE_INTERVAL_MS) return;
    this.lastUsageWrite = now;
    try {
      this.data.writeJson(USAGE_FILE, { [id]: now }, { mode: SECRET_MODE });
    } catch (error) {
      // Losing one timestamp must not fail the authenticated request.
      console.error("[auth] could not record token use", error);
    }
  }
}
