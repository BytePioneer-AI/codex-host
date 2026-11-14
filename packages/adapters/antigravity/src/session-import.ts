import { constants, createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  HarnessResult,
  HarnessSessionImportCapability,
  HarnessSessionImportSource,
} from "@codexhost/harness-adapter";
import {
  SessionImportChangedError,
  SessionImportScope,
  isMissingFileError,
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
  nativeBrainDirPath,
  nativeConversationDbPath,
  nativeConversationSummariesDbPath,
} from "./fork.js";
import { antigravityHome } from "./usage-statistics.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function workspacePaths(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  let uris: unknown;
  try {
    uris = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(uris)) return [];
  const paths: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string" || uri.includes("\0")) continue;
    try {
      let cwd = uri;
      if (uri.startsWith("file:")) {
        const url = new URL(uri);
        if (url.hostname && url.hostname !== "localhost") continue;
        cwd = fileURLToPath(url);
      }
      if (!path.isAbsolute(cwd)) continue;
      cwd = path.resolve(cwd);
      const normalized = `${cwd.replaceAll("\\", "/")}/`;
      if (normalized.includes("/.codexhost/antigravity-history/hooks/")) continue;
      paths.push(cwd);
    } catch {
      // Malformed or nonlocal URIs are not resumable workspaces.
    }
  }
  return paths;
}

async function firstUserTitle(file: string, signal: AbortSignal): Promise<string | null> {
  const stream = createReadStream(file, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === "USER_INPUT") return sessionImportTitle(record.content);
    }
    return null;
  } catch (error) {
    signal.throwIfAborted();
    if (isMissingFileError(error)) return null;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Read-only discovery of root Conversations; no native process or Session is opened. */
export class AntigravitySessionImport implements HarnessSessionImportCapability {
  readonly #home: string;
  readonly #scope = new SessionImportScope({
    closedMessage: "Antigravity Session import is closed",
    unavailableMessage: "Antigravity sessions could not be read; check storage access and retry",
    notFoundMessage: "Antigravity Session is no longer importable",
  });

  constructor(environment: NodeJS.ProcessEnv) {
    this.#home = antigravityHome(environment);
  }

  async listCandidates(options?: {
    signal?: AbortSignal;
  }): Promise<HarnessResult<HarnessSessionImportCandidate[]>> {
    return this.#scope.read(async (scopeSignal) => {
      const signal = options?.signal ? AbortSignal.any([scopeSignal, options.signal]) : scopeSignal;
      const candidates: HarnessSessionImportCandidate[] = [];
      for (const row of await this.#rows(signal)) {
        signal.throwIfAborted();
        try {
          const source = await this.#source(row, signal);
          if (source) candidates.push(source.candidate);
        } catch (error) {
          if (!(error instanceof SessionImportChangedError)) throw error;
        }
      }
      return candidates;
    });
  }

  async resolveCandidate(
    nativeSessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<HarnessResult<HarnessSessionImportSource>> {
    return this.#scope.resolve(async (scopeSignal) => {
      const signal = options?.signal ? AbortSignal.any([scopeSignal, options.signal]) : scopeSignal;
      if (!SESSION_ID.test(nativeSessionId)) return null;
      const [row] = await this.#rows(signal, nativeSessionId);
      return row ? this.#source(row, signal) : null;
    });
  }

  close(): Promise<void> {
    return this.#scope.close();
  }

  async #rows(signal: AbortSignal, nativeSessionId?: string): Promise<Record<string, unknown>[]> {
    signal.throwIfAborted();
    const file = nativeConversationSummariesDbPath(this.#home);
    const info = await optionalLstat(file);
    if (!info?.isFile()) return [];
    const { DatabaseSync } = await import("node:sqlite");
    signal.throwIfAborted();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return nativeSessionId === undefined
        ? db.prepare("SELECT * FROM conversation_summaries").all()
        : db
            .prepare("SELECT * FROM conversation_summaries WHERE conversation_id = ?")
            .all(nativeSessionId);
    } finally {
      db.close();
    }
  }

  async #source(
    row: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<HarnessSessionImportSource | null> {
    signal.throwIfAborted();
    const id = row.conversation_id;
    if (
      typeof id !== "string" ||
      !SESSION_ID.test(id) ||
      (typeof row.parent_conversation_id === "string" && row.parent_conversation_id.length > 0) ||
      typeof row.step_count !== "number" ||
      !Number.isSafeInteger(row.step_count) ||
      row.step_count <= 0 ||
      (row.killed !== undefined && row.killed !== null && row.killed !== 0)
    ) {
      return null;
    }
    const file = nativeConversationDbPath(id, this.#home);
    try {
      return await readStableFiles([file], async ([info]) => {
        if (!info?.isFile()) return null;
        await access(file, constants.R_OK);
        let cwd: string | undefined;
        for (const directory of workspacePaths(row.workspace_uris)) {
          if ((await stat(directory).catch(() => null))?.isDirectory()) {
            cwd = directory;
            break;
          }
        }
        if (!cwd) return null;
        const title =
          sessionImportTitle(row.title) ??
          sessionImportTitle(row.preview) ??
          (await firstUserTitle(
            path.join(
              nativeBrainDirPath(id, this.#home),
              ".system_generated",
              "logs",
              "transcript.jsonl",
            ),
            signal,
          ));
        signal.throwIfAborted();
        const candidate = sessionImportCandidate({
          nativeSessionId: id,
          cwd,
          title,
          updatedAt: row.last_modified_time,
          running:
            row.status === "CASCADE_RUN_STATUS_RUNNING"
              ? true
              : row.status === "CASCADE_RUN_STATUS_IDLE"
                ? false
                : null,
        });
        return candidate
          ? {
              candidate,
              nativeRef: nativeSessionRefSchema.parse({
                harnessId: "antigravity",
                nativeSessionId: id,
                formatVersion: 1,
              }),
            }
          : null;
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SessionImportChangedError) throw error;
      return null;
    }
  }
}
