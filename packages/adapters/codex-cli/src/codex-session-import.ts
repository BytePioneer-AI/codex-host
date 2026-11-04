import {
  sessionImportCandidate,
  sessionImportTitle,
} from "@codexhost/harness-adapter/session-import";
import type { HarnessSessionImportCandidate } from "@codexhost/shared-contracts";
import type { HarnessError } from "@codexhost/harness-adapter";

import { CodexRpcError, type CodexAppServer } from "./rpc.js";

export function isCodexWriterConflict(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.method === "thread/resume" &&
    error.error.code === -32600 &&
    /^thread \S+ already has (?:an active writer|a live local writer)$/iu.test(error.error.message)
  );
}

export function codexOpenFailure(error: unknown): HarnessError {
  return isCodexWriterConflict(error)
    ? {
        code: "sessionBusy",
        message: "Codex Session is open in another client. Close it there, then retry.",
        retryable: true,
      }
    : {
        code: "nativeFailure",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
}

/** A busy import may copy only the prefix ending at its latest completed native Turn. */
export async function newestCompletedCodexTurn(
  server: CodexAppServer,
  threadId: string,
): Promise<string | null> {
  const cursors = new Set<string>();
  const turns = new Set<string>();
  let cursor: string | null = null;
  do {
    const response: { data: Array<{ id: string; status: string }>; nextCursor?: string | null } =
      await server.request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
    if (!Array.isArray(response.data)) throw new Error("Codex returned invalid Turn history");
    for (const turn of response.data) {
      if (
        !turn ||
        typeof turn.id !== "string" ||
        !turn.id ||
        !["completed", "interrupted", "failed", "inProgress"].includes(turn.status) ||
        turns.has(turn.id)
      )
        throw new Error("Codex returned invalid or repeated Turn history");
      turns.add(turn.id);
      if (turn.status === "completed") return turn.id;
    }
    cursor = response.nextCursor ?? null;
    if (cursor !== null) {
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || !response.data.length)
        throw new Error("Codex Turn history cursor did not advance");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return null;
}

function candidateFromThread(value: unknown): HarnessSessionImportCandidate | null {
  if (!value || typeof value !== "object") return null;
  const thread = value as Record<string, unknown>;
  if (thread.ephemeral !== false || thread.parentThreadId !== null) return null;
  const preview =
    typeof thread.preview === "string"
      ? thread.preview.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#"))
      : undefined;
  return sessionImportCandidate({
    nativeSessionId: thread.id,
    title: sessionImportTitle(thread.name ?? preview, 200),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt * 1000 : undefined,
    cwd: thread.cwd,
    running: null,
  });
}

/** Read-only resolution by logical ID uses the same native history selection as resume. */
export async function readCodexImportCandidate(
  server: CodexAppServer,
  nativeSessionId: string,
  signal: AbortSignal,
): Promise<HarnessSessionImportCandidate | null> {
  signal.throwIfAborted();
  let response: { thread: unknown };
  try {
    response = await server.request("thread/read", {
      threadId: nativeSessionId,
      includeTurns: false,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof CodexRpcError &&
      error.error.code === -32600 &&
      /^(?:thread not loaded:|thread not found:|no rollout found for thread)/iu.test(
        error.error.message,
      )
    )
      return null;
    throw error;
  }
  signal.throwIfAborted();
  const candidate = candidateFromThread(response.thread);
  return candidate?.nativeSessionId === nativeSessionId ? candidate : null;
}

/** Native rollout segments may repeat a logical Session ID within or across pages. */
export async function listCodexImportCandidates(
  server: CodexAppServer,
  signal: AbortSignal,
): Promise<HarnessSessionImportCandidate[]> {
  const candidates = new Map<string, HarnessSessionImportCandidate>();
  const duplicates = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    signal.throwIfAborted();
    const response: { data: unknown[]; nextCursor?: string | null } = await server.request(
      "thread/list",
      { limit: 200, sortKey: "updated_at", cursor },
    );
    signal.throwIfAborted();
    for (const thread of response.data) {
      const candidate = candidateFromThread(thread);
      if (!candidate) continue;
      const id = candidate.nativeSessionId;
      if (candidates.has(id)) duplicates.add(id);
      else candidates.set(id, candidate);
    }
    cursor = response.nextCursor ?? null;
    if (cursor !== null) {
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || !response.data.length)
        throw new Error("Codex CLI Session list cursor did not advance");
      cursors.add(cursor);
    }
  } while (cursor !== null);

  // File ordering is not a contract for which segment the native runtime will resume.
  for (const id of duplicates) {
    const candidate = await readCodexImportCandidate(server, id, signal);
    if (candidate) candidates.set(id, candidate);
    else candidates.delete(id);
  }
  signal.throwIfAborted();
  return [...candidates.values()];
}
