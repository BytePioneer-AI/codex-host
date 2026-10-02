import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  readStableFiles,
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import type { HarnessSessionImportCandidate } from "@codexhost/shared-contracts";

import {
  createKimiNativeSessionRef,
  getKimiCodeHome,
  locateKimiSession,
  readKimiSessionSnapshot,
} from "./history.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adapter-owned, read-only discovery from Kimi's `session_index.jsonl`. It never starts Kimi or
 * writes native files; resume stays ACP `session/load` in the recorded working directory.
 */
export class KimiSessionImport implements HarnessSessionImportCapability {
  readonly #home: string;
  readonly #scope = new SessionImportScope({
    closedMessage: "Kimi Session import is closed",
    unavailableMessage:
      "Kimi sessions could not be read; close native clients, check storage access and retry",
    notFoundMessage: "Kimi Session is no longer importable",
  });

  constructor(options: { environment: NodeJS.ProcessEnv; homeDirectory?: string | undefined }) {
    this.#home = getKimiCodeHome(options.homeDirectory, options.environment);
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) => {
      const candidates: HarnessSessionImportCandidate[] = [];
      for (const nativeSessionId of await this.#indexedSessions(signal)) {
        try {
          const source = await this.#source(nativeSessionId, signal);
          if (source) candidates.push(source.candidate);
        } catch (error) {
          if (!(error instanceof SessionImportChangedError)) throw error;
        }
      }
      return candidates;
    });
  }

  resolveCandidate(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (signal) =>
      (await this.#indexedSessions(signal)).has(nativeSessionId)
        ? this.#source(nativeSessionId, signal)
        : null,
    );
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  /** Live identities in Kimi's index. The last record of an identity decides, as in resume. */
  async #indexedSessions(signal: AbortSignal): Promise<Set<string>> {
    const live = new Set<string>();
    let content: string;
    try {
      content = await readFile(path.join(this.#home, "session_index.jsonl"), {
        encoding: "utf8",
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (isMissingFileError(error)) return live;
      throw error;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // Kimi's index is append-only; a torn line is ignored, as resume does.
        continue;
      }
      if (!isRecord(entry) || typeof entry.sessionId !== "string" || !entry.sessionId) continue;
      if (entry.deleted || typeof entry.sessionDir !== "string") live.delete(entry.sessionId);
      else live.add(entry.sessionId);
    }
    return live;
  }

  async #source(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportSource | null> {
    signal.throwIfAborted();
    const options = { kimiCodeHome: this.#home };
    let located: Awaited<ReturnType<typeof locateKimiSession>>;
    try {
      // The lookup resume uses: index entry, directory confined to Kimi's home, matching state.
      located = await locateKimiSession(nativeSessionId, options);
    } catch (error) {
      if (isStorageAccessError(error)) throw error;
      return null;
    }
    if (!located) return null;
    const { state } = located;
    const files = [
      path.join(located.sessionDir, "state.json"),
      path.join(located.mainHomeDir, "wire.jsonl"),
    ] as const;
    return readStableFiles(files, async ([stateInfo, wire]) => {
      if (!stateInfo?.isFile() || !wire?.isFile()) return null;
      try {
        if (typeof state.cwd !== "string" || !path.isAbsolute(state.cwd)) return null;
        // Kept as Kimi recorded it; resume loads the Session in exactly this directory.
        const cwd = path.resolve(state.cwd);
        if (!(await stat(cwd)).isDirectory()) return null;
        signal.throwIfAborted();
        // The reader resume uses. A history it rejects, or one without a user prompt on the
        // active branch, has nothing to continue.
        const { turns } = await readKimiSessionSnapshot(nativeSessionId, options);
        const prompt = turns
          .flatMap((turn) => turn.input)
          .find((input) => input.type === "text" && input.text.trim().length > 0);
        if (!prompt) return null;
        const activity = turns
          .flatMap((turn) => [turn.completedAtMs, turn.startedAtMs])
          .filter((time): time is number => typeof time === "number" && Number.isFinite(time));
        const candidate = sessionImportCandidate({
          nativeSessionId,
          cwd,
          title:
            sessionImportTitle((state as unknown as Record<string, unknown>).title) ??
            sessionImportTitle(prompt.text),
          // Wire record times are milliseconds; the state file's unit is not documented.
          updatedAt: activity.length > 0 ? Math.max(...activity) : wire.mtimeMs,
          // Kimi has no cross-process activity marker: idleness cannot be established.
        });
        return candidate
          ? { candidate, nativeRef: createKimiNativeSessionRef(nativeSessionId, cwd) }
          : null;
      } catch (error) {
        signal.throwIfAborted();
        if (isStorageAccessError(error)) throw error;
        // Incomplete, missing or unsupported stores are ignored, never migrated.
        return null;
      }
    });
  }
}
