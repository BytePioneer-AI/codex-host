import { opendir, readFile, stat } from "node:fs/promises";
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
  optionalLstat,
  readStableFiles,
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import {
  nativeSessionRefSchema,
  type HarnessSessionImportCandidate,
} from "@codexhost/shared-contracts";

import {
  kiroHomeDir,
  readKiroSessionMessages,
  type KiroHistoryRow,
  type KiroSessionMeta,
} from "./history.js";
import { kiroVisibleText } from "./visible-text.js";

const MAX_METADATA_BYTES = 1024 * 1024;
// Kiro keeps its own bookkeeping next to the per-workspace Session directories.
const NON_WORKSPACE_DIRECTORIES = new Set(["cli"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userText(row: KiroHistoryRow): string {
  const { content, text } = row.payload;
  return kiroVisibleText(typeof content === "string" ? content : (text ?? ""));
}

/**
 * Adapter-owned, read-only discovery over `~/.kiro/sessions/<workspace>/<session>/`. It never
 * starts Kiro, copies a Transcript or writes native files; resume stays ACP `session/load`.
 */
export class KiroSessionImport implements HarnessSessionImportCapability {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #scope = new SessionImportScope({
    closedMessage: "Kiro Session import is closed",
    unavailableMessage:
      "Kiro sessions could not be read; close native clients, check storage access and retry",
    notFoundMessage: "Kiro Session is no longer importable",
  });

  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = { ...environment };
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) => {
      const candidates: HarnessSessionImportCandidate[] = [];
      for (const [, directories] of await this.#sessionDirectories(signal)) {
        // The same identity under two workspaces cannot be resumed unambiguously.
        if (directories.length !== 1 || !directories[0]) continue;
        try {
          const candidate = await this.#candidate(directories[0], signal);
          if (candidate) candidates.push(candidate);
        } catch (error) {
          // A Session being written is left out of this listing, never imported from stale data.
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
      const candidate = await this.#candidate(directories[0], signal);
      if (!candidate) return null;
      return {
        candidate,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "kiro-cli",
          nativeSessionId,
          formatVersion: 1,
        }),
      };
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  /** Session ID to every directory claiming it. Enumerated links are not followed. */
  async #sessionDirectories(signal: AbortSignal): Promise<Map<string, string[]>> {
    const root = path.join(kiroHomeDir(this.#environment), "sessions");
    const found = new Map<string, string[]>();
    const info = await optionalLstat(root);
    if (!info) return found;
    if (!info.isDirectory()) throw new Error("Kiro Session store is not a directory");
    for await (const workspace of await opendir(root)) {
      signal.throwIfAborted();
      if (!workspace.isDirectory() || NON_WORKSPACE_DIRECTORIES.has(workspace.name)) continue;
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
    signal: AbortSignal,
  ): Promise<HarnessSessionImportCandidate | null> {
    signal.throwIfAborted();
    const files = [
      path.join(sessionDirectory, "session.json"),
      path.join(sessionDirectory, "messages.jsonl"),
    ] as const;
    return readStableFiles(files, async ([metadata, messages]) => {
      if (!metadata?.isFile() || !messages?.isFile() || metadata.size > MAX_METADATA_BYTES)
        return null;
      try {
        const meta: unknown = JSON.parse(await readFile(files[0], { encoding: "utf8", signal }));
        if (!isRecord(meta) || meta.id !== path.basename(sessionDirectory)) return null;
        const workspacePath: unknown = Array.isArray(meta.workspacePaths)
          ? meta.workspacePaths[0]
          : undefined;
        if (
          typeof workspacePath !== "string" ||
          !path.isAbsolute(workspacePath) ||
          workspacePath.includes("\0")
        )
          return null;
        // Kept as Kiro recorded it: resume hands this path back to the native workspace lookup.
        const cwd = path.resolve(workspacePath);
        if (!(await stat(cwd)).isDirectory()) return null;
        signal.throwIfAborted();
        // The same reader resume uses: an unreadable row or a Fork whose parent is gone is not
        // importable, and a Session without a user message has nothing to continue.
        const rows = await readKiroSessionMessages({
          sessionDirectory,
          sessionMeta: meta as unknown as KiroSessionMeta,
          cwd,
        });
        const firstUser = rows.find((row) => row.payload.type === "user");
        if (!firstUser) return null;
        const modified =
          typeof meta.lastModifiedAt === "string" ? Date.parse(meta.lastModifiedAt) : Number.NaN;
        // Native `status` is that client's own view; it does not prove no other process is
        // attached, so activity stays unknown.
        return sessionImportCandidate({
          nativeSessionId: meta.id,
          cwd,
          title: sessionImportTitle(meta.title) ?? sessionImportTitle(userText(firstUser)),
          updatedAt: Number.isFinite(modified) && modified >= 0 ? modified : messages.mtimeMs,
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
