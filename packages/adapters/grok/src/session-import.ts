import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import type {
  HarnessResult,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import {
  SessionImportChangedError,
  SessionImportScope,
  isMissingFileError,
  isStorageAccessError,
  optionalLstat,
  readStableFiles,
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import {
  nativeSessionRefSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";

import { grokHomeDir } from "./acp-transport.js";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
// Subagent Sessions belong to their parent and are projected through it, never opened alone.
const SUBAGENT_SESSION_KINDS = new Set(["subagent", "subagent_resume"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file: string, signal: AbortSignal): Promise<unknown> {
  return JSON.parse(await readFile(file, { encoding: "utf8", signal })) as unknown;
}

function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to another user.
    return isRecord(error) && error.code === "EPERM";
  }
}

/** First real user prompt in Grok's ACP update log, or null when the Session has none. */
async function firstUserText(file: string, signal: AbortSignal): Promise<string | null> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.includes("user_message_chunk")) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const update = isRecord(entry) && isRecord(entry.params) ? entry.params.update : null;
      if (!isRecord(update) || update.sessionUpdate !== "user_message_chunk") continue;
      const text = isRecord(update.content) ? update.content.text : null;
      return typeof text === "string" ? text : "";
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Adapter-owned, read-only discovery over `~/.grok/sessions/<encoded cwd>/<session>/`. ACP
 * `session/list` only answers for one cwd, so all workspaces are found from native storage.
 */
export class GrokSessionImport implements HarnessSessionImportCapability {
  readonly #environment: NodeJS.ProcessEnv | undefined;
  readonly #scope = new SessionImportScope({
    closedMessage: "Grok Session import is closed",
    unavailableMessage:
      "Grok sessions could not be read; close native clients, check storage access and retry",
    notFoundMessage: "Grok Session is no longer importable",
  });

  constructor(environment: NodeJS.ProcessEnv | undefined) {
    this.#environment = environment ? { ...environment } : undefined;
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) => {
      const active = await this.#activeSessions(signal);
      const candidates: HarnessSessionImportCandidate[] = [];
      for (const [, directories] of await this.#sessionDirectories(signal)) {
        // One identity under two workspaces cannot be resumed unambiguously.
        if (directories.length !== 1 || !directories[0]) continue;
        try {
          const candidate = await this.#candidate(directories[0], active, signal);
          if (candidate) candidates.push(candidate);
        } catch (error) {
          if (!(error instanceof SessionImportChangedError)) throw error;
        }
      }
      return candidates;
    });
  }

  resolveCandidate(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (signal) => {
      const directories = (await this.#sessionDirectories(signal)).get(nativeSessionId);
      if (directories?.length !== 1 || !directories[0]) return null;
      const candidate = await this.#candidate(
        directories[0],
        await this.#activeSessions(signal),
        signal,
      );
      if (!candidate) return null;
      return {
        candidate,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "grok",
          nativeSessionId,
          formatVersion: 1,
        }),
      };
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  #home(): string {
    return grokHomeDir(this.#environment ? { environment: this.#environment } : {});
  }

  /** IDs a live Grok process currently holds open, from Grok's own registry. */
  async #activeSessions(signal: AbortSignal): Promise<ReadonlySet<string>> {
    const active = new Set<string>();
    let entries: unknown;
    try {
      entries = await readJson(path.join(this.#home(), "active_sessions.json"), signal);
    } catch (error) {
      signal.throwIfAborted();
      if (isStorageAccessError(error)) throw error;
      return active;
    }
    if (!Array.isArray(entries)) return active;
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.session_id === "string" && processAlive(entry.pid))
        active.add(entry.session_id);
    }
    return active;
  }

  /** Session ID to every directory claiming it. Enumerated links are not followed. */
  async #sessionDirectories(signal: AbortSignal): Promise<Map<string, string[]>> {
    const root = path.join(this.#home(), "sessions");
    const found = new Map<string, string[]>();
    const info = await optionalLstat(root);
    if (!info) return found;
    if (!info.isDirectory()) throw new Error("Grok Session store is not a directory");
    for await (const workspace of await opendir(root)) {
      signal.throwIfAborted();
      if (!workspace.isDirectory()) continue;
      const workspaceDirectory = path.join(root, workspace.name);
      const sessions = await opendir(workspaceDirectory).catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
      if (!sessions) continue;
      for await (const session of sessions) {
        signal.throwIfAborted();
        if (!session.isDirectory()) continue;
        const directories = found.get(session.name) ?? [];
        directories.push(path.join(workspaceDirectory, session.name));
        found.set(session.name, directories);
      }
    }
    return found;
  }

  async #candidate(
    sessionDirectory: string,
    active: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportCandidate | null> {
    signal.throwIfAborted();
    const nativeSessionId = path.basename(sessionDirectory);
    const files = [
      path.join(sessionDirectory, "summary.json"),
      path.join(sessionDirectory, "updates.jsonl"),
    ] as const;
    return readStableFiles(files, async ([summaryInfo, updates]) => {
      if (!summaryInfo?.isFile() || !updates?.isFile() || summaryInfo.size > MAX_METADATA_BYTES)
        return null;
      try {
        const summary = await readJson(files[0], signal);
        if (!isRecord(summary) || !isRecord(summary.info) || summary.info.id !== nativeSessionId)
          return null;
        if (
          typeof summary.session_kind === "string" &&
          SUBAGENT_SESSION_KINDS.has(summary.session_kind)
        )
          return null;
        const nativeCwd = summary.info.cwd;
        if (
          typeof nativeCwd !== "string" ||
          !path.isAbsolute(nativeCwd) ||
          nativeCwd.includes("\0")
        )
          return null;
        // Resume derives the history directory from the cwd it is given, so the candidate cwd
        // must encode to exactly the directory this Session lives in. Not a real path.
        const cwd = path.resolve(nativeCwd);
        if (encodeURIComponent(cwd) !== path.basename(path.dirname(sessionDirectory))) return null;
        if (!(await stat(cwd)).isDirectory()) return null;
        const prompt = await firstUserText(files[1], signal);
        if (prompt === null) return null;
        const updatedAt = [summary.last_active_at, summary.updated_at]
          .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
          .find((value) => Number.isFinite(value) && value >= 0);
        return sessionImportCandidate({
          nativeSessionId,
          cwd,
          title:
            sessionImportTitle(summary.generated_title) ??
            sessionImportTitle(summary.session_summary) ??
            sessionImportTitle(prompt),
          updatedAt: updatedAt ?? updates.mtimeMs,
          // Grok registers open Sessions with their process. Absence is not proof of idleness.
          running: active.has(nativeSessionId) ? true : null,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (isStorageAccessError(error)) throw error;
        // Incomplete, missing or unsupported stores are ignored, never migrated.
        return null;
      }
    });
  }
}
