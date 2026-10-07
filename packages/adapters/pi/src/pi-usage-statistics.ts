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

import { piSessionImportDirectory } from "./pi-session-import.js";
import { piUsageRecord } from "./pi-usage.js";

/**
 * Every assistant message in one Pi session file, keyed as the live meter keys it. A fork starts
 * with a copy of its parent's entries, request IDs and times included, so the Host's dedup
 * counts them once, even after the parent file is deleted.
 */
export async function readPiUsage(file: string, signal: AbortSignal): Promise<HarnessUsageEntry[]> {
  const entries: HarnessUsageEntry[] = [];
  // The session header (`"type":"session"`, with id and cwd) opens the file.
  const header = await jsonlHeader(file, (record) => record.type === "session", signal);
  const session = {
    sessionId: typeof header?.id === "string" ? header.id : undefined,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
  };
  for await (const line of jsonlRecords(file, '"assistant"', signal)) {
    if (line.type !== "message") continue;
    const record = piUsageRecord(line.message);
    if (record?.kind !== "request") continue;
    const message = line.message as Record<string, unknown>;
    const at = nativeTimeMs(message.timestamp) ?? nativeTimeMs(line.timestamp);
    const entry = at !== null && usageEntryFromRequest(record.request, at);
    if (entry) entries.push(withUsageSession(entry, session));
  }
  return entries;
}

export function createPiUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    // <project>/<session>.jsonl and its subagents' <session>/<id>/run-*/session.jsonl
    listSources: (signal: AbortSignal) =>
      jsonlUsageSources(piSessionImportDirectory(environment).directory, 4, signal),
    readSource: (id: string, signal: AbortSignal) => readPiUsage(id, signal),
  });
}
