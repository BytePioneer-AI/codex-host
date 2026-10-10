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
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import { piSessionImportDirectory } from "./pi-session-import.js";
import { piUsageRecord } from "./pi-usage.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function piUserText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ");
}

/**
 * Every assistant message in one Pi session file, keyed by response ID or native entry ID and time. A fork starts
 * with a copy of its parent's entries, request IDs and times included, so the Host's dedup
 * counts them once, even after the parent file is deleted.
 */
export async function readPiUsage(file: string, signal: AbortSignal): Promise<HarnessUsageEntry[]> {
  const entries: HarnessUsageEntry[] = [];
  // The session header (`"type":"session"`, with id and cwd) opens the file.
  const header = await jsonlHeader(file, (record) => record.type === "session", signal);
  let name: string | undefined;
  const session = {
    sessionId: typeof header?.id === "string" ? header.id : undefined,
    cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
  };
  for await (const line of jsonlRecords(file, '"type"', signal)) {
    if (line.type === "session_info") {
      name = usageSessionTitle(line.name) ?? name;
      continue;
    }
    if (line.type !== "message") continue;
    const message = line.message as Record<string, unknown>;
    if (!name && message?.role === "user") {
      name = usageSessionTitle(piUserText(message.content));
    }
    const record = piUsageRecord(line.message);
    if (record?.kind !== "request") continue;
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
  return name
    ? entries.map((entry) => withUsageSession(entry, { ...session, title: name }))
    : entries;
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
