import { createReadStream } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandDirectory(value: string, home: string): string {
  return path.resolve(
    value === "~"
      ? home
      : value.startsWith(`~${path.sep}`) || value.startsWith("~/")
        ? path.join(home, value.slice(2))
        : value,
  );
}

/** OMP keeps Pi's storage variables: a flat explicit Session directory, or per-cwd directories. */
export function ompSessionImportDirectory(environment: NodeJS.ProcessEnv): {
  directory: string;
  flat: boolean;
} {
  const home =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || os.homedir();
  const custom = environment.PI_CODING_AGENT_SESSION_DIR;
  if (custom) return { directory: expandDirectory(custom, home), flat: true };
  const agent = environment.PI_CODING_AGENT_DIR;
  return {
    directory: path.join(
      agent ? expandDirectory(agent, home) : path.join(home, ".omp", "agent"),
      "sessions",
    ),
    flat: false,
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String((part as Record<string, unknown>).text))
    .join(" ");
}

interface SessionFacts {
  nativeSessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: number | null;
}

/**
 * One streaming pass over an OMP Session file: the `title` record, the `session` header and the
 * Entry tree. Only ancestry flags are kept, never message bodies.
 */
async function readFacts(file: string, signal: AbortSignal): Promise<SessionFacts | null> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: { id: string; cwd: string } | null = null;
  let nativeTitle: string | null = null;
  let firstPrompt: string | null = null;
  let updatedAt: number | null = null;
  let leafHasUser = false;
  const hasUserAncestry = new Map<string, boolean>();
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // OMP's own history reader skips an unreadable line.
        continue;
      }
      if (!isRecord(entry)) continue;
      if (entry.type === "title") {
        nativeTitle = sessionImportTitle(entry.title);
        continue;
      }
      if (entry.type === "session") {
        if (header) return null;
        if (
          typeof entry.id !== "string" ||
          entry.id.length === 0 ||
          typeof entry.cwd !== "string" ||
          !path.isAbsolute(entry.cwd)
        )
          return null;
        header = { id: entry.id, cwd: entry.cwd };
        continue;
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) continue;
      const message = isRecord(entry.message) ? entry.message : null;
      const isUser = entry.type === "message" && message?.role === "user";
      if (isUser) firstPrompt ??= sessionImportTitle(messageText(message?.content));
      // The last Entry is the leaf OMP resumes from; its branch must contain a user message.
      leafHasUser =
        isUser ||
        (typeof entry.parentId === "string" && hasUserAncestry.get(entry.parentId) === true);
      hasUserAncestry.set(entry.id, leafHasUser);
      if (entry.type === "message" && (message?.role === "user" || message?.role === "assistant")) {
        const time =
          typeof message.timestamp === "number"
            ? message.timestamp
            : typeof entry.timestamp === "string"
              ? Date.parse(entry.timestamp)
              : Number.NaN;
        if (Number.isFinite(time) && time >= 0) updatedAt = time;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!header || !leafHasUser) return null;
  return {
    nativeSessionId: header.id,
    cwd: header.cwd,
    title: nativeTitle ?? firstPrompt,
    updatedAt,
  };
}

/**
 * Adapter-owned, read-only discovery over OMP's Session files. It never starts OMP or writes
 * native files; resume stays `--session <file>` through the returned locator.
 */
export class OmpSessionImport implements HarnessSessionImportCapability {
  readonly #location: ReturnType<typeof ompSessionImportDirectory>;
  readonly #scope = new SessionImportScope({
    closedMessage: "Omp Session import is closed",
    unavailableMessage:
      "Omp sessions could not be read; close native clients, check storage access and retry",
    notFoundMessage: "Omp Session is no longer importable",
  });

  constructor(environment: NodeJS.ProcessEnv) {
    this.#location = ompSessionImportDirectory(environment);
  }

  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (signal) =>
      [...(await this.#sources(signal)).values()].flatMap((sources) =>
        // One identity in two files cannot be resumed unambiguously.
        sources.length === 1 && sources[0] ? [sources[0].candidate] : [],
      ),
    );
  }

  resolveCandidate(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (signal) => {
      const sources = (await this.#sources(signal)).get(nativeSessionId);
      if (sources?.length !== 1 || !sources[0]) return null;
      // Re-read the selected file at the commit boundary; a change now refuses this import.
      const source = await this.#source(sources[0].file, signal);
      return source?.nativeRef.nativeSessionId === nativeSessionId
        ? { candidate: source.candidate, nativeRef: source.nativeRef }
        : null;
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  async #sessionFiles(signal: AbortSignal): Promise<string[]> {
    const { directory, flat } = this.#location;
    const info = await optionalLstat(directory);
    if (!info) return [];
    if (!info.isDirectory()) throw new Error("Omp Session store is not a directory");
    const files: string[] = [];
    const visit = async (current: string, projectLevel: boolean): Promise<void> => {
      const entries = await opendir(current).catch((error: unknown) => {
        if (isMissingFileError(error)) return null;
        throw error;
      });
      if (!entries) return;
      for await (const entry of entries) {
        signal.throwIfAborted();
        // One level only: Subagent transcripts live in `<session stem>/` below a project and
        // enumerated links are not followed.
        if (projectLevel && entry.isDirectory()) await visit(path.join(current, entry.name), false);
        else if (!projectLevel && entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(path.join(current, entry.name));
      }
    };
    await visit(directory, !flat);
    return files;
  }

  /** Session ID to every readable file claiming it. Files changing under the read are skipped. */
  async #sources(signal: AbortSignal): Promise<Map<string, OmpSource[]>> {
    const found = new Map<string, OmpSource[]>();
    for (const file of await this.#sessionFiles(signal)) {
      signal.throwIfAborted();
      try {
        const source = await this.#source(file, signal);
        if (!source) continue;
        const sources = found.get(source.nativeRef.nativeSessionId) ?? [];
        sources.push(source);
        found.set(source.nativeRef.nativeSessionId, sources);
      } catch (error) {
        if (!(error instanceof SessionImportChangedError)) throw error;
      }
    }
    return found;
  }

  async #source(file: string, signal: AbortSignal): Promise<OmpSource | null> {
    signal.throwIfAborted();
    return readStableFiles([file], async ([info]) => {
      if (!info?.isFile() || info.size === 0) return null;
      try {
        const facts = await readFacts(file, signal);
        if (!facts) return null;
        const cwd = await realpath(facts.cwd);
        if (!(await stat(cwd)).isDirectory()) return null;
        const candidate = sessionImportCandidate({
          nativeSessionId: facts.nativeSessionId,
          cwd,
          title: facts.title,
          updatedAt: facts.updatedAt ?? info.mtimeMs,
          // OMP has no cross-process activity marker: idleness cannot be established.
        });
        if (!candidate) return null;
        return {
          file,
          candidate,
          // Resume needs the file itself: OMP is started with `--session <file>`.
          nativeRef: nativeSessionRefSchema.parse({
            harnessId: "omp",
            nativeSessionId: facts.nativeSessionId,
            locator: { sessionFile: await realpath(file) },
            formatVersion: 1,
          }),
        };
      } catch (error) {
        signal.throwIfAborted();
        if (isStorageAccessError(error)) throw error;
        // Missing projects and unsupported files are ignored, never migrated.
        return null;
      }
    });
  }
}

/** A source plus the enumerated file it was read from. The path never leaves the Adapter. */
type OmpSource = HarnessSessionImportSource & { file: string };
