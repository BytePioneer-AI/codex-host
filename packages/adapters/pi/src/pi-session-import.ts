import { createReadStream, type Stats } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import {
  HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH,
  harnessSessionImportCandidateSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

// Pi's documented v3 JSONL format, not a second Transcript store. Discovery never opens an Agent.
class PiSessionChangedError extends Error {
  constructor() {
    super("Pi Session changed during discovery; refresh and retry");
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino &&
    left.dev === right.dev
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
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

/** Mirrors Pi CLI's explicit flat session-dir override versus default per-cwd directories. */
export function piSessionImportDirectory(environment: NodeJS.ProcessEnv): {
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
      agent ? expandDirectory(agent, home) : path.join(home, ".pi", "agent"),
      "sessions",
    ),
    flat: false,
  };
}

async function sessionFiles(
  directory: string,
  flat: boolean,
  signal: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, projectLevel: boolean): Promise<void> => {
    signal.throwIfAborted();
    const entries = await opendir(dir).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!entries) return;
    for await (const entry of entries) {
      signal.throwIfAborted();
      // Do not follow symlinks into unrelated storage or recursively scan arbitrary folders.
      if (projectLevel && entry.isDirectory()) await visit(path.join(dir, entry.name), false);
      else if (!projectLevel && entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  await visit(directory, !flat);
  return files;
}

async function readCandidate(
  file: string,
  signal: AbortSignal,
): Promise<HarnessSessionImportSource | null> {
  const before = await stat(file);
  if (!before.isFile() || before.size === 0) return null;
  const stream = createReadStream(file, { encoding: "utf8", signal, end: before.size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  let name: string | null = null;
  let firstMessage: string | null = null;
  let hasUser = false;
  let updatedAt = before.mtimeMs;
  // Only ancestry flags are retained, never message bodies or Transcript entries.
  const entries = new Map<string, boolean>();
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return null;
      }
      if (!isRecord(entry)) return null;
      if (!header) {
        // Older versions may migrate and regenerate entry IDs on native load. Do not guess.
        if (
          entry.type !== "session" ||
          entry.version !== 3 ||
          typeof entry.id !== "string" ||
          typeof entry.cwd !== "string" ||
          !path.isAbsolute(entry.cwd)
        )
          return null;
        header = entry;
        continue;
      }
      if (
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        entries.has(entry.id) ||
        (entry.parentId !== null &&
          (typeof entry.parentId !== "string" || !entries.has(entry.parentId)))
      )
        return null;
      const message = isRecord(entry.message) ? entry.message : null;
      if (!firstMessage && entry.type === "message" && message?.role === "user") {
        const content = message.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter(
                    (block) =>
                      isRecord(block) && block.type === "text" && typeof block.text === "string",
                  )
                  .map((block) => block.text)
                  .join(" ")
              : "";
        firstMessage =
          text.replaceAll("\0", "").trim().slice(0, HARNESS_SESSION_IMPORT_TITLE_MAX_LENGTH) ||
          null;
      }
      hasUser =
        (entry.type === "message" && message?.role === "user") ||
        (typeof entry.parentId === "string" && entries.get(entry.parentId) === true);
      entries.set(entry.id, hasUser);
      if (entry.type === "session_info")
        name = typeof entry.name === "string" ? entry.name.trim() || null : null;
      if (entry.type === "message" && (message?.role === "user" || message?.role === "assistant")) {
        const time =
          typeof message.timestamp === "number"
            ? message.timestamp
            : typeof entry.timestamp === "string"
              ? Date.parse(entry.timestamp)
              : NaN;
        if (Number.isFinite(time)) updatedAt = time;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!header) return null;
  if (!hasUser) return null;
  const after = await stat(file);
  if (!sameFile(before, after)) throw new PiSessionChangedError();
  const cwd = await realpath(String(header.cwd));
  if (!(await stat(cwd)).isDirectory()) return null;
  const nativeRef = nativeSessionRefSchema.safeParse({
    harnessId: "pi",
    nativeSessionId: header.id,
    locator: { sessionFile: await realpath(file) },
    formatVersion: 1,
  });
  const candidate = harnessSessionImportCandidateSchema.safeParse({
    nativeSessionId: header.id,
    cwd,
    title: name ?? firstMessage,
    updatedAt: Math.floor(updatedAt),
    running: null,
  });
  return candidate.success && nativeRef.success
    ? { candidate: candidate.data, nativeRef: nativeRef.data }
    : null;
}

/** Read just the header when checking whether a new/changed file shares a selected identity. */
async function readIdentity(file: string, signal: AbortSignal): Promise<string | null> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      let header: unknown;
      try {
        header = JSON.parse(line);
      } catch {
        return null;
      }
      return isRecord(header) &&
        header.type === "session" &&
        header.version === 3 &&
        typeof header.id === "string"
        ? header.id
        : null;
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Per-Adapter metadata index. First discovery streams storage; subsequent queries reuse unchanged files. */
export class PiSessionImportIndex {
  readonly #location: ReturnType<typeof piSessionImportDirectory>;
  #cache = new Map<string, { fingerprint: Stats; source: HarnessSessionImportSource }>();
  #listing: Promise<HarnessSessionImportSource[]> | undefined;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#location = piSessionImportDirectory(environment);
  }

  list(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    this.#listing ??= this.#scan(signal).finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #scan(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    const { directory, flat } = this.#location;
    const files = await sessionFiles(directory, flat, signal);
    const next = new Map<string, { fingerprint: Stats; source: HarnessSessionImportSource }>();
    const identities = new Set<string>();
    const sources: HarnessSessionImportSource[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      try {
        const fingerprint = await stat(file);
        const cached = this.#cache.get(file);
        const source =
          cached && sameFile(cached.fingerprint, fingerprint)
            ? cached.source
            : await readCandidate(file, signal);
        if (!source) continue;
        // A deleted/recreated project must not be hidden forever by a cached file result.
        if (!(await stat(source.candidate.cwd)).isDirectory()) continue;
        if (identities.has(source.nativeRef.nativeSessionId))
          throw new Error("Pi Session identity is ambiguous across files");
        identities.add(source.nativeRef.nativeSessionId);
        next.set(file, { fingerprint, source });
        sources.push(source);
      } catch (error) {
        // An actively changing or deleted Session must not block every other Session's listing.
        if (!missing(error) && !(error instanceof PiSessionChangedError)) throw error;
      }
    }
    this.#cache = next;
    return structuredClone(
      sources.sort((left, right) => right.candidate.updatedAt - left.candidate.updatedAt),
    );
  }

  async resolve(
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportSource | null> {
    const { directory, flat } = this.#location;
    let selected: string | undefined;
    for (const file of await sessionFiles(directory, flat, signal)) {
      signal.throwIfAborted();
      try {
        const fingerprint = await stat(file);
        const cached = this.#cache.get(file);
        const id =
          cached && sameFile(cached.fingerprint, fingerprint)
            ? cached.source.nativeRef.nativeSessionId
            : await readIdentity(file, signal);
        if (id !== nativeSessionId) continue;
        if (selected) throw new Error("Pi Session identity is ambiguous across files");
        selected = file;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    if (!selected) return null;
    try {
      // No cached eligibility or browser locator is trusted at the commit boundary.
      const source = await readCandidate(selected, signal);
      return source?.nativeRef.nativeSessionId === nativeSessionId ? source : null;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
}

export function listPiSessionImportSources(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<HarnessSessionImportSource[]> {
  return new PiSessionImportIndex(environment).list(signal);
}
