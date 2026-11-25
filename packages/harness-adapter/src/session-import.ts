import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

import {
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  harnessSessionImportCandidateSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";

import type { HarnessResult, HarnessSessionImportSource } from "./text-session.js";

// Shared mechanics for Adapter-owned Session import. Native storage layout, eligibility and
// locators stay in each plugin; nothing here knows a Harness.

/** A native Session moved under a read. Listings skip it; a selected import is refused. */
export class SessionImportChangedError extends Error {
  constructor(message = "Native Session changed during discovery; refresh and retry") {
    super(message);
    this.name = "SessionImportChangedError";
  }
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Identity plus content fingerprint. Two absent files match; absent never matches present. */
export function sameFileFingerprint(left: Stats | null, right: Stats | null): boolean {
  return left === null || right === null
    ? left === right
    : left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs;
}

const STORAGE_ACCESS_ERRORS = new Set(["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"]);

/**
 * The store itself could not be read. Unlike a malformed or unsupported Session, this must fail
 * the read instead of looking like "no candidates".
 */
export function isStorageAccessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    STORAGE_ACCESS_ERRORS.has(error.code)
  );
}

/** `lstat` that reports absence as null. Links are described, never followed. */
export async function optionalLstat(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * Read a Session's files only if none of them changes, appears or disappears meanwhile; otherwise
 * throw SessionImportChangedError. `read` receives the fingerprints taken before reading.
 */
export async function readStableFiles<T>(
  files: readonly string[],
  read: (before: readonly (Stats | null)[]) => Promise<T>,
): Promise<T> {
  const before = await Promise.all(files.map(optionalLstat));
  const value = await read(before);
  const after = await Promise.all(files.map(optionalLstat));
  if (before.some((info, index) => !sameFileFingerprint(info, after[index] ?? null)))
    throw new SessionImportChangedError();
  return value;
}

/** Single-line title within the shared contract: NUL removed, whitespace folded, cut on a character. */
export function sessionImportTitle(
  value: unknown,
  maxLength = HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\0", "").replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return null;
  // Cheap bound first: a UTF-16 length within the limit cannot exceed it in characters.
  if (normalized.length <= maxLength) return normalized;
  const characters = [...normalized];
  if (characters.length <= maxLength) return normalized;
  return `${characters
    .slice(0, maxLength - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Build one candidate or nothing. The Host validates the whole listing with the same schema, so a
 * row that is passed on unchecked would hide every other Session of that Harness.
 */
export function sessionImportCandidate(input: {
  nativeSessionId: unknown;
  cwd: unknown;
  /** Already normalized by the plugin; blank becomes null. */
  title: unknown;
  /** Epoch milliseconds or a date string. Fractions are dropped. */
  updatedAt: unknown;
  running?: unknown;
}): HarnessSessionImportCandidate | null {
  const time =
    typeof input.updatedAt === "number"
      ? input.updatedAt
      : typeof input.updatedAt === "string"
        ? Date.parse(input.updatedAt)
        : Number.NaN;
  const parsed = harnessSessionImportCandidateSchema.safeParse({
    nativeSessionId: input.nativeSessionId,
    cwd: input.cwd,
    title: typeof input.title === "string" && input.title.trim().length > 0 ? input.title : null,
    updatedAt: Math.floor(time),
    // Unknown must stay unknown; only an explicit boolean is a native statement.
    running: typeof input.running === "boolean" ? input.running : null,
  });
  return parsed.success ? parsed.data : null;
}

export interface SessionImportScopeOptions {
  /** Result message once the owner closed, e.g. "Pi Adapter is closed". */
  closedMessage: string;
  /** Result message for a failed read; never includes the native error. */
  unavailableMessage: string;
  /** Result message when the selected Session is gone or no longer eligible. */
  notFoundMessage: string;
}

/**
 * Lifetime of one Adapter's discovery reads: nothing starts after close, running reads are
 * cancelled and awaited, and failures become bounded results instead of rejections.
 */
export class SessionImportScope {
  readonly #abort = new AbortController();
  readonly #options: SessionImportScopeOptions;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: SessionImportScopeOptions) {
    this.#options = options;
  }

  #closed<T>(): HarnessResult<T> {
    return {
      ok: false,
      error: { code: "invalidState", message: this.#options.closedMessage, retryable: false },
    };
  }

  read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<HarnessResult<T>> {
    const signal = this.#abort.signal;
    if (signal.aborted) return Promise.resolve(this.#closed());
    let started: Promise<T>;
    try {
      started = operation(signal);
    } catch (error) {
      // A synchronous throw is a failed read, not a rejection of the capability call.
      started = Promise.reject(error instanceof Error ? error : new Error("Session read failed"));
    }
    const request: Promise<HarnessResult<T>> = started
      .then((value): HarnessResult<T> => (signal.aborted ? this.#closed() : { ok: true, value }))
      .catch((): HarnessResult<T> =>
        signal.aborted
          ? this.#closed()
          : {
              ok: false,
              error: {
                code: "unavailable",
                message: this.#options.unavailableMessage,
                retryable: true,
              },
            },
      )
      .finally(() => this.#pending.delete(request));
    this.#pending.add(request);
    return request;
  }

  /** `read` for `resolveCandidate`: a null source is the selected Session having disappeared. */
  async resolve(
    operation: (signal: AbortSignal) => Promise<HarnessSessionImportSource | null>,
  ): Promise<HarnessResult<HarnessSessionImportSource>> {
    const result = await this.read(operation);
    if (!result.ok) return result;
    return result.value
      ? { ok: true, value: result.value }
      : {
          ok: false,
          error: {
            code: "sessionNotFound",
            message: this.#options.notFoundMessage,
            retryable: false,
          },
        };
  }

  /** Idempotent. Resolves after every started read has settled. */
  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(this.#pending);
  }
}
