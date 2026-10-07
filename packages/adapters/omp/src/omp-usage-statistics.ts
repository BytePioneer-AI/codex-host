import type {
  HarnessUsageEntry,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  jsonlHeader,
  jsonlRecords,
  jsonlUsageSources,
  nativeTimeMs,
  usageEntryFromRequest,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import { ompSessionImportDirectory } from "./session-import.js";
import { ompUsageRecord } from "./omp-usage.js";

/**
 * Every assistant message in one OMP session file, keyed by response ID or native entry ID and time. A fork
 * starts with a copy of its parent's entries (its header, after OMP's title line, names the
 * parent), request IDs and times included, so the Host's dedup counts them once.
 */
export async function readOmpUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const entries: HarnessUsageEntry[] = [];
  // The session header (`"type":"session"`, with id and cwd) opens the file.
  const header = await jsonlHeader(file, (record) => record.type === "session", signal);
  const session = {
    sessionId: typeof header?.id === "string" ? header.id : undefined,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
  };
  for await (const line of jsonlRecords(file, '"assistant"', signal)) {
    if (line.type !== "message") continue;
    const record = ompUsageRecord(line.message);
    if (record?.kind !== "request") continue;
    const message = line.message as Record<string, unknown>;
    const at = nativeTimeMs(message.timestamp) ?? nativeTimeMs(line.timestamp);
    const entry = at !== null && usageEntryFromRequest(record.request, at);
    if (!entry) continue;
    if (!(typeof message.responseId === "string" && message.responseId.length > 0)) {
      // Native entry IDs survive copied fork history; timestamps alone collide across sessions.
      if (typeof line.id !== "string" || line.id.length === 0) continue;
      entry.id = `entry:${line.id}:${entry.id}`;
    }
    entries.push(withUsageSession(entry, session));
  }
  return entries;
}

export function createOmpUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    // <project>/<session>.jsonl and its subagents' and advisor's in <session>/
    listSources: (signal: AbortSignal) =>
      jsonlUsageSources(ompSessionImportDirectory(environment).directory, 4, signal),
    readSource: (id: string, signal: AbortSignal) => readOmpUsage(id, signal),
  });
}
