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
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import { CODEBUDDY_RUNTIME_PROFILE, record, type CodeBuddyRuntimeProfile } from "./common.js";
import { codeBuddyConfigRoot, codeBuddyNativeHistory } from "./history.js";

// The identity `validateNativeRef` accepts; anything else could never be resumed.
const SESSION_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,199})\.jsonl$/u;
const MAX_HISTORY_BYTES = 64_000_000;
const MAX_MARKER_BYTES = 64 * 1024;

function processAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // The process exists but belongs to another user.
    return record(error).code === "EPERM";
  }
}

function userText(row: Record<string, unknown>): string | null {
  if (row.type !== "message" || row.role !== "user") return null;
  const { content } = row;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => record(part))
    .filter((part) => typeof part.text === "string")
    .map((part) => String(part.text))
    .join(" ");
}

interface SessionFacts {
  cwd: string;
  title: string | null;
  updatedAt: number | null;
}

/** One streaming pass for metadata. Full validation is left to the reader resume uses. */
async function readFacts(file: string, signal: AbortSignal): Promise<SessionFacts | null> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd: string | null = null;
  let customTitle: string | null = null;
  let generatedTitle: string | null = null;
  let firstPrompt: string | null = null;
  let hasUser = false;
  let updatedAt: number | null = null;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Resume refuses a history with an invalid record; so does import.
        return null;
      }
      const row = record(parsed);
      if (typeof row.cwd === "string" && path.isAbsolute(row.cwd)) cwd ??= row.cwd;
      if (typeof row.timestamp === "number" && Number.isFinite(row.timestamp))
        updatedAt = row.timestamp;
      if (row.type === "custom-title") customTitle = sessionImportTitle(row.customTitle);
      else if (row.type === "ai-title") generatedTitle = sessionImportTitle(row.aiTitle);
      else {
        const text = userText(row);
        if (text !== null) {
          hasUser = true;
          firstPrompt ??= sessionImportTitle(text);
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!hasUser || !cwd) return null;
  return { cwd, title: customTitle ?? generatedTitle ?? firstPrompt, updatedAt };
}

/**
 * Adapter-owned, read-only discovery over `<config>/projects/<project>/<session>.jsonl`, shared
 * by every product profile built on this Adapter. Resume stays ACP `session/load`.
 */
export class CodeBuddySessionImport implements HarnessSessionImportCapability {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #profile: CodeBuddyRuntimeProfile;
  readonly #scope: SessionImportScope;

  constructor(
    environment: NodeJS.ProcessEnv,
    profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
  ) {
    this.#environment = { ...environment };
    this.#profile = profile;
    this.#scope = new SessionImportScope({
      closedMessage: `${profile.displayName} Session import is closed`,
      unavailableMessage: `${profile.displayName} sessions could not be read; close native clients, check storage access and retry`,
      notFoundMessage: `${profile.displayName} Session is no longer importable`,
    });
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) => {
      const active = await this.#activeSessions(signal);
      const candidates: HarnessSessionImportCandidate[] = [];
      for (const [nativeSessionId, files] of await this.#sessionFiles(signal)) {
        // Resume refuses an identity stored under two projects.
        if (files.length !== 1 || !files[0]) continue;
        try {
          const source = await this.#source(nativeSessionId, files[0], active, signal);
          if (source) candidates.push(source.candidate);
        } catch (error) {
          if (!(error instanceof SessionImportChangedError)) throw error;
        }
      }
      return candidates;
    });
  }

  resolveCandidate(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (signal) => {
      const files = (await this.#sessionFiles(signal)).get(nativeSessionId);
      if (files?.length !== 1 || !files[0]) return null;
      return this.#source(nativeSessionId, files[0], await this.#activeSessions(signal), signal);
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  #root(): string {
    return codeBuddyConfigRoot(this.#environment, this.#profile);
  }

  /** IDs a live native process registered in `<config>/sessions/<pid>.json`. */
  async #activeSessions(signal: AbortSignal): Promise<ReadonlySet<string>> {
    const active = new Set<string>();
    const directory = path.join(this.#root(), "sessions");
    const markers = await opendir(directory).catch((error: unknown) => {
      if (isMissingFileError(error) || record(error).code === "ENOTDIR") return null;
      throw error;
    });
    if (!markers) return active;
    for await (const marker of markers) {
      signal.throwIfAborted();
      if (!marker.isFile() || !marker.name.endsWith(".json")) continue;
      try {
        const file = path.join(directory, marker.name);
        if ((await stat(file)).size > MAX_MARKER_BYTES) continue;
        const entry = record(JSON.parse(await readFile(file, { encoding: "utf8", signal })));
        if (typeof entry.sessionId === "string" && processAlive(entry.pid))
          active.add(entry.sessionId);
      } catch (error) {
        signal.throwIfAborted();
        if (isStorageAccessError(error)) throw error;
        // A marker removed or half-written by an exiting process says nothing.
      }
    }
    return active;
  }

  /** Session ID to every project file claiming it. Enumerated links are not followed. */
  async #sessionFiles(signal: AbortSignal): Promise<Map<string, string[]>> {
    const root = path.join(this.#root(), "projects");
    const found = new Map<string, string[]>();
    const info = await optionalLstat(root);
    if (!info) return found;
    if (!info.isDirectory())
      throw new Error(`${this.#profile.displayName} Session store is not a directory`);
    for await (const project of await opendir(root)) {
      signal.throwIfAborted();
      if (!project.isDirectory()) continue;
      const projectDirectory = path.join(root, project.name);
      const entries = await opendir(projectDirectory).catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
      if (!entries) continue;
      for await (const entry of entries) {
        signal.throwIfAborted();
        // Subagent transcripts live in per-Session subdirectories and are not descended into.
        const nativeSessionId = entry.isFile() ? SESSION_FILE.exec(entry.name)?.[1] : undefined;
        if (!nativeSessionId) continue;
        const files = found.get(nativeSessionId) ?? [];
        files.push(path.join(projectDirectory, entry.name));
        found.set(nativeSessionId, files);
      }
    }
    return found;
  }

  async #source(
    nativeSessionId: string,
    file: string,
    active: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportSource | null> {
    signal.throwIfAborted();
    return readStableFiles([file], async ([info]) => {
      if (!info?.isFile() || info.size === 0 || info.size > MAX_HISTORY_BYTES) return null;
      try {
        const facts = await readFacts(file, signal);
        if (!facts) return null;
        // Kept as CodeBuddy recorded it; resume compares it with every row's directory.
        const cwd = path.resolve(facts.cwd);
        if (!(await stat(cwd)).isDirectory()) return null;
        const nativeRef: NativeSessionRef = nativeSessionRefSchema.parse({
          harnessId: this.#profile.harnessId,
          nativeSessionId,
          formatVersion: 1,
        });
        signal.throwIfAborted();
        // The gate resume itself applies: one unambiguous file, one Session identity, one
        // working directory, and for Fork-capable profiles the project's primary location.
        const history = await codeBuddyNativeHistory(
          cwd,
          nativeRef,
          this.#environment,
          this.#profile,
        );
        if (path.resolve(history.file) !== path.resolve(file)) return null;
        const candidate = sessionImportCandidate({
          nativeSessionId,
          cwd,
          title: facts.title,
          updatedAt: facts.updatedAt ?? info.mtimeMs,
          // A registered live process holds the Session. Absence is not proof of idleness.
          running: active.has(nativeSessionId) ? true : null,
        });
        return candidate ? { candidate, nativeRef } : null;
      } catch (error) {
        signal.throwIfAborted();
        if (isStorageAccessError(error)) throw error;
        // Incomplete, foreign or unsupported histories are ignored, never migrated.
        return null;
      }
    });
  }
}
