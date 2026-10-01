// Discovery adapted from liki-0814/codex-host, feat/cursor-optimize (7d9df8ba), LGPL-3.0.
import type { Stats } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessResult,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import {
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  harnessSessionImportCandidateSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";
import {
  cursorConfigDirectory,
  cursorSessionDirectory,
  readCursorNativeTurns,
} from "./native-history.js";
import { cursorNativeSessionRef } from "./session-ref.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_METADATA_BYTES = 1024 * 1024;
class CursorSessionChangedError extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
async function optionalStat(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}
function sameFile(left: Stats | null, right: Stats | null): boolean {
  return left === null || right === null
    ? left === right
    : left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs;
}

/** Adapter-owned, read-only discovery. No process startup, transcript copy or Host mapping writes. */
export class CursorSessionImport implements HarnessSessionImportCapability {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #abort = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = { ...environment };
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#read(async (signal) => {
      const root = path.join(cursorConfigDirectory(this.#environment), "acp-sessions");
      const info = await optionalStat(root);
      if (!info) return [];
      if (!info.isDirectory()) throw new Error("Cursor ACP store is not a directory");
      const candidates: HarnessSessionImportCandidate[] = [];
      const entries = await opendir(root);
      for await (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
        try {
          const candidate = await this.#candidate(entry.name, signal);
          if (candidate) candidates.push(candidate);
        } catch (error) {
          // A changing Session is omitted from this listing, never imported from
          // cached metadata. Storage permission errors must remain visible.
          if (!(error instanceof CursorSessionChangedError)) throw error;
        }
      }
      return candidates;
    });
  }

  async resolveCandidate(
    nativeSessionId: string,
  ): Promise<HarnessResult<HarnessSessionImportSource>> {
    if (!SESSION_ID.test(nativeSessionId))
      return {
        ok: false,
        error: {
          code: "invalidRequest",
          message: "Invalid Cursor ACP Session ID",
          retryable: false,
        },
      };
    const result = await this.#read((signal) => this.#candidate(nativeSessionId, signal));
    if (!result.ok) return result;
    if (!result.value)
      return {
        ok: false,
        error: {
          code: "sessionNotFound",
          message: "Cursor ACP Session is no longer importable",
          retryable: false,
        },
      };
    return {
      ok: true,
      value: {
        candidate: result.value,
        // Native ACP stores do not attest to --force. Imported sessions must not
        // acquire unattended privileges from UI defaults or a guessed locator.
        nativeRef: cursorNativeSessionRef(nativeSessionId, "default"),
      },
    };
  }

  async #candidate(id: string, signal: AbortSignal): Promise<HarnessSessionImportCandidate | null> {
    signal.throwIfAborted();
    const root = path.join(cursorConfigDirectory(this.#environment), "acp-sessions");
    if (!(await optionalStat(root))?.isDirectory()) return null;
    const directory = cursorSessionDirectory(id, this.#environment);
    const files = [
      directory,
      path.join(directory, "meta.json"),
      path.join(directory, "store.db"),
      path.join(directory, "store.db-wal"),
    ] as const;
    const before = await Promise.all(files.map(optionalStat));
    const [folder, metadata, database, wal] = before;
    if (
      !folder?.isDirectory() ||
      !metadata?.isFile() ||
      !database?.isFile() ||
      (wal && !wal.isFile()) ||
      metadata.size > MAX_METADATA_BYTES
    )
      return null;
    let cwd: string;
    let title: string | null;
    try {
      const raw: unknown = JSON.parse(await readFile(files[1], { encoding: "utf8", signal }));
      if (
        !raw ||
        typeof raw !== "object" ||
        !("cwd" in raw) ||
        typeof raw.cwd !== "string" ||
        !path.isAbsolute(raw.cwd) ||
        raw.cwd.includes("\0")
      )
        return null;
      cwd = await realpath(raw.cwd);
      if (!(await stat(cwd)).isDirectory()) return null;
      signal.throwIfAborted();
      // Reuse the resume gate: metadata agentId, root blobs, native Turn IDs,
      // workspace and the history chain must all be readable and consistent.
      const turns = readCursorNativeTurns(id, cwd, this.#environment);
      if (!turns.length) return null;
      title =
        turns[0]?.text
          .replaceAll("\0", "")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH) || null;
    } catch (error) {
      signal.throwIfAborted();
      if (["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes(errorCode(error) ?? ""))
        throw error;
      // Ignore incomplete, missing or unsupported stores. Do not migrate them.
      return null;
    }
    signal.throwIfAborted();
    const after = await Promise.all(files.map(optionalStat));
    if (before.some((info, index) => !sameFile(info, after[index] ?? null)))
      throw new CursorSessionChangedError("Cursor Session changed during discovery");
    const parsed = harnessSessionImportCandidateSchema.safeParse({
      nativeSessionId: id,
      cwd,
      title,
      updatedAt: Math.floor(Math.max(database.mtimeMs, wal?.mtimeMs ?? 0)),
      // A stable read does not establish that another Cursor process is idle.
      running: null,
    });
    return parsed.success ? parsed.data : null;
  }

  #read<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<HarnessResult<T>> {
    const signal = this.#abort.signal;
    if (signal.aborted)
      return Promise.resolve({
        ok: false,
        error: {
          code: "invalidState",
          message: "Cursor Session import is closed",
          retryable: false,
        },
      });
    const request = operation(signal)
      .then((value): HarnessResult<T> => {
        signal.throwIfAborted();
        return { ok: true, value };
      })
      .catch((): HarnessResult<T> => ({
        ok: false,
        error: {
          code: signal.aborted ? "invalidState" : "unavailable",
          message: signal.aborted
            ? "Cursor Session import is closed"
            : "Cursor ACP sessions could not be read; close native clients, check storage access and retry",
          retryable: !signal.aborted,
        },
      }))
      .finally(() => this.#pending.delete(request));
    this.#pending.add(request);
    return request;
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled(this.#pending);
  }
}
