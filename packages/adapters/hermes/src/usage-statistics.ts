import os from "node:os";
import path from "node:path";
import { lstat } from "node:fs/promises";

import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import { usageEntryFromRequest, usageSessionTitle, withUsageSession } from "@codexhost/harness-adapter/usage-statistics";

import type { HostUsageRequest } from "@codexhost/harness-adapter";

/**
 * Hermes records usage per session in its `state.db` (schema 31+), not per request: each row of
 * `sessions` aggregates every API call of one native session — token buckets, the call count, the
 * last model, the working directory and the display title. The reader therefore emits one
 * statistics entry per session, attributed to the session's last activity; `id` is the stable
 * native session ID, so re-reads and resumes deduplicate naturally.
 */
export function hermesStateDatabasePath(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const configured = environment.HERMES_HOME;
  return path.resolve(configured ? path.join(configured, "state.db") : path.join(home, ".hermes", "state.db"));
}

async function fingerprint(file: string): Promise<string | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  // Committed pages may sit in the write-ahead log until a checkpoint.
  const wal = await lstat(`${file}-wal`).catch(() => null);
  return `${info.ino}:${info.size}:${info.mtimeMs}:${wal ? `${wal.size}:${wal.mtimeMs}` : "-"}`;
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * One statistics entry from a `sessions` row, or null for rows without recorded API calls.
 * Hermes normalizes every wire so its input bucket excludes cache reads and writes; the
 * convention here counts input including cache, so the buckets are recombined. Cache buckets
 * are only attached when both are known, keeping the pricing rule "unknown is not zero".
 */
export function hermesUsageEntry(row: Record<string, unknown>): HarnessUsageEntry | null {
  const apiCalls = tokenCount(row.api_call_count) ? row.api_call_count : 0;
  const input = tokenCount(row.input_tokens) ? row.input_tokens : 0;
  const output = tokenCount(row.output_tokens) ? row.output_tokens : 0;
  const cacheRead = tokenCount(row.cache_read_tokens) ? row.cache_read_tokens : 0;
  const cacheWrite = tokenCount(row.cache_write_tokens) ? row.cache_write_tokens : 0;
  const reasoning = tokenCount(row.reasoning_tokens) ? row.reasoning_tokens : 0;
  if (apiCalls === 0 && input === 0 && output === 0) return null;
  const id = typeof row.id === "string" && row.id.length > 0 ? row.id : null;
  const lastActivity = typeof row.last_activity_at === "number" ? Math.floor(row.last_activity_at * 1000) : null;
  const started = typeof row.started_at === "number" ? Math.floor(row.started_at * 1000) : null;
  const at = lastActivity ?? started;
  if (id === null || at === null || at <= 0) return null;
  const request: HostUsageRequest = {
    requestId: id,
    ...(typeof row.model === "string" && row.model.length > 0 ? { model: row.model } : {}),
    inputTokens: input + cacheRead + cacheWrite,
    outputTokens: output,
    ...(reasoning > 0 ? { reasoningOutputTokens: reasoning } : {}),
    // Both buckets exist whenever either does: the writer records them as a pair.
    ...(cacheRead > 0 || cacheWrite > 0 ? { cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite } : {}),
  };
  const entry = usageEntryFromRequest(request, at);
  if (!entry) return null;
  return withUsageSession(entry, {
    sessionId: id,
    cwd: typeof row.cwd === "string" ? row.cwd : undefined,
    title: usageSessionTitle(row.title ?? row.display_name),
  });
}

const SESSIONS_QUERY = `
  SELECT id, model, cwd, title, display_name, started_at, last_activity_at,
         api_call_count, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, reasoning_tokens
    FROM sessions`;

/**
 * Every Hermes session with recorded API usage in the database, read-only. Hidden sessions are
 * ordinary usage; rows without calls or tokens contribute nothing. A locked or missing database
 * surfaces as a read failure so the page reports the harness instead of silently hiding usage.
 */
export async function readHermesUsage(file: string): Promise<HarnessUsageEntry[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const entries: HarnessUsageEntry[] = [];
    for (const row of database.prepare(SESSIONS_QUERY).iterate()) {
      const entry = hermesUsageEntry(row as Record<string, unknown>);
      if (entry) entries.push(entry);
    }
    return entries;
  } finally {
    database.close();
  }
}

export function createHermesUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    async listSources(): Promise<HarnessUsageSource[]> {
      const file = hermesStateDatabasePath(environment);
      const stamp = await fingerprint(file);
      return stamp ? [{ id: file, fingerprint: stamp }] : [];
    },
    readSource: (id: string) => readHermesUsage(id),
  });
}
