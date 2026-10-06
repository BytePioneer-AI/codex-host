import { createReadStream, type Stats } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { HarnessSessionImportSource } from "@codexhost/harness-adapter";
import {
  SessionImportChangedError,
  isMissingFileError,
  sameFileFingerprint,
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { z } from "zod";

const CLAUDE_SESSION_IMPORT_TITLE_MAX_LENGTH = 120;
const CLAUDE_INTERNAL_USER_TEXT = /^<(?:local-command-|command-)/u;

const CLAUDE_SESSION_CHANGED = "Claude Code Session changed during discovery; refresh and retry";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown): string | null {
  return sessionImportTitle(value, CLAUDE_SESSION_IMPORT_TITLE_MAX_LENGTH);
}

function userText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "user") return null;
  const { content } = message;
  const text =
    typeof content === "string"
      ? cleanText(content)
      : Array.isArray(content)
        ? cleanText(
            content
              .filter(
                (block) =>
                  isRecord(block) && block.type === "text" && typeof block.text === "string",
              )
              .map((block) => String(block.text))
              .join(" "),
          )
        : null;
  return text && !CLAUDE_INTERNAL_USER_TEXT.test(text) ? text : null;
}

export function claudeProjectsDirectory(environment: NodeJS.ProcessEnv): string {
  const home =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME) || os.homedir();
  return path.join(
    path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")),
    "projects",
  );
}

async function sessionFiles(directory: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const projects = await opendir(directory).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  if (!projects) return [];
  const files: string[] = [];
  for await (const project of projects) {
    signal.throwIfAborted();
    // Claude stores main transcripts exactly one directory below projects. Do not follow links
    // or descend into per-Session subagent storage.
    if (!project.isDirectory()) continue;
    const entries = await opendir(path.join(directory, project.name)).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!entries) continue;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(directory, project.name, entry.name));
      }
    }
  }
  return files;
}

async function readCandidate(
  file: string,
  signal: AbortSignal,
): Promise<HarnessSessionImportSource | null> {
  const nativeSessionId = path.basename(file, ".jsonl");
  if (!z.uuid().safeParse(nativeSessionId).success) return null;
  const before = await stat(file);
  if (!before.isFile() || before.size === 0) return null;
  const stream = createReadStream(file, { encoding: "utf8", signal, end: before.size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let cwd: string | null = null;
  let customTitle: string | null = null;
  let generatedTitle: string | null = null;
  let firstPrompt: string | null = null;
  let hasConversation = false;
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // Claude's own history reader tolerates individual corrupt/partial records. A stable file
        // can still contain a completely resumable conversation around such a record.
        continue;
      }
      if (!isRecord(entry)) continue;
      if (typeof entry.sessionId === "string" && entry.sessionId !== nativeSessionId) return null;
      if (entry.isSidechain === true) continue;
      if (typeof entry.cwd === "string" && path.isAbsolute(entry.cwd)) cwd = entry.cwd;
      if (entry.type === "custom-title") {
        customTitle = cleanText(entry.customTitle);
      } else if (entry.type === "ai-title") {
        generatedTitle = cleanText(entry.aiTitle);
      } else if (entry.type === "summary") {
        generatedTitle = cleanText(entry.summary) ?? generatedTitle;
      } else if (entry.type === "user" || entry.type === "assistant") {
        hasConversation = true;
        if (!firstPrompt && entry.type === "user") firstPrompt = userText(entry.message);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!hasConversation || !cwd) return null;
  const after = await stat(file);
  if (!sameFileFingerprint(before, after))
    throw new SessionImportChangedError(CLAUDE_SESSION_CHANGED);
  const resolvedCwd = await realpath(cwd);
  if (!(await stat(resolvedCwd)).isDirectory()) return null;
  const candidate = sessionImportCandidate({
    nativeSessionId,
    title: customTitle ?? generatedTitle ?? firstPrompt,
    updatedAt: before.mtimeMs,
    cwd: resolvedCwd,
  });
  const nativeRef = nativeSessionRefSchema.safeParse({
    harnessId: "claude-code",
    nativeSessionId,
    formatVersion: 1,
  });
  return candidate && nativeRef.success ? { candidate, nativeRef: nativeRef.data } : null;
}

/** Cached read-only index over Claude Code's native main-session transcripts. */
export class ClaudeSessionImportIndex {
  readonly #directory: string;
  #cache = new Map<string, { fingerprint: Stats; source: HarnessSessionImportSource }>();
  #listing: Promise<HarnessSessionImportSource[]> | undefined;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#directory = claudeProjectsDirectory(environment);
  }

  list(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    this.#listing ??= this.#scan(signal).finally(() => {
      this.#listing = undefined;
    });
    return this.#listing;
  }

  async #scan(signal: AbortSignal): Promise<HarnessSessionImportSource[]> {
    const next = new Map<string, { fingerprint: Stats; source: HarnessSessionImportSource }>();
    const identities = new Set<string>();
    const sources: HarnessSessionImportSource[] = [];
    for (const file of await sessionFiles(this.#directory, signal)) {
      signal.throwIfAborted();
      try {
        const fingerprint = await stat(file);
        const cached = this.#cache.get(file);
        const source =
          cached && sameFileFingerprint(cached.fingerprint, fingerprint)
            ? cached.source
            : await readCandidate(file, signal);
        if (!source) continue;
        if (!(await stat(source.candidate.cwd)).isDirectory()) continue;
        if (identities.has(source.candidate.nativeSessionId)) {
          throw new Error("Claude Code Session identity is ambiguous across files");
        }
        identities.add(source.candidate.nativeSessionId);
        next.set(file, { fingerprint, source });
        sources.push(source);
      } catch (error) {
        // A native client may append or remove one Session while the rest remain importable.
        if (!isMissingFileError(error) && !(error instanceof SessionImportChangedError))
          throw error;
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
    if (!z.uuid().safeParse(nativeSessionId).success) return null;
    let selected: string | undefined;
    for (const file of await sessionFiles(this.#directory, signal)) {
      signal.throwIfAborted();
      if (path.basename(file, ".jsonl") !== nativeSessionId) continue;
      if (selected) throw new Error("Claude Code Session identity is ambiguous across files");
      selected = file;
    }
    if (!selected) return null;
    try {
      // Re-read the chosen Transcript at the mapping boundary; cached browser metadata is not
      // trusted as a resumable identity.
      const source = await readCandidate(selected, signal);
      return source?.candidate.nativeSessionId === nativeSessionId ? source : null;
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }
}
