/** DSH owns Workspace identity, canonical paths, titles and Session membership. */
import { ModernRemoteConnectionError } from "./remote-connection.js";
import type { ModernJournalRemote } from "./journal.js";
import { realpath } from "node:fs/promises";

/** Preserve stored paths while accepting aliases of the same native project directory. */
export async function matchesModernCwd(
  actual: string | undefined,
  expected: string | undefined,
): Promise<boolean> {
  if (actual === expected) return true;
  if (actual === undefined || expected === undefined) return false;
  try {
    const [actualPath, expectedPath] = await Promise.all([realpath(actual), realpath(expected)]);
    return actualPath === expectedPath;
  } catch {
    return false;
  }
}

interface ModernWorkspace {
  readonly workspaceId: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native create is idempotent by realpath and preserves an existing Workspace's title. */
export async function resolveModernWorkspace(
  remote: ModernJournalRemote,
  cwd: string,
  signal: AbortSignal,
): Promise<ModernWorkspace> {
  const result = await remote.call<unknown>("workspace/create", { request: { path: cwd } }, signal);
  if (!result.ok) {
    throw new ModernRemoteConnectionError(
      "unavailable",
      "DeepSeek Harness could not resolve the project Workspace",
      result.error.code,
      result.error,
    );
  }
  const workspace = record(result.value) ? result.value.workspace : undefined;
  if (
    !record(result.value) ||
    typeof result.value.created !== "boolean" ||
    !record(workspace) ||
    typeof workspace.workspaceId !== "string" ||
    !workspace.workspaceId.trim() ||
    typeof workspace.path !== "string" ||
    !workspace.path.trim() ||
    !Array.isArray(workspace.sessionIds) ||
    !workspace.sessionIds.every((id) => typeof id === "string" && id.trim())
  ) {
    throw new ModernRemoteConnectionError(
      "protocolError",
      "DeepSeek Harness returned an invalid project Workspace",
    );
  }
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    sessionIds: workspace.sessionIds,
  };
}
