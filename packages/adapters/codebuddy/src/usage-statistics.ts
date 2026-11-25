import path from "node:path";

import type {
  HarnessUsageEntry,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  jsonlRecords,
  jsonlUsageSources,
  nativeTimeMs,
  usageEntryFromRequest,
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

import type { CodeBuddyRuntimeProfile } from "./common.js";
import { codeBuddyConfigRoot, NATIVE_MESSAGE_TYPES, providerUsageRequest } from "./history.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function codeBuddyUserText(row: Record<string, unknown>): string | undefined {
  if (row.type !== "message" || row.role !== "user") return undefined;
  const { content } = row;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => record(part))
    .filter((part) => typeof part.text === "string")
    .map((part) => String(part.text))
    .join(" ");
}

/**
 * Every request in one CodeBuddy or WorkBuddy transcript, one per `providerData.messageId`
 * across all native branches, as the live meter reads it. Subagent rows count here too: the
 * machine-wide total includes subagents, and their own transcripts repeat the same message IDs.
 */
export async function readCodeBuddyUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const messages = new Map<string, { data: Record<string, unknown>; at: number | null }>();
  let sessionId: unknown;
  let cwd: unknown;
  let customTitle: string | undefined;
  let generatedTitle: string | undefined;
  let firstPrompt: string | undefined;
  for await (const row of jsonlRecords(file, '"type"', signal)) {
    if (row.type === "custom-title") customTitle = usageSessionTitle(row.customTitle);
    else if (row.type === "ai-title") generatedTitle = usageSessionTitle(row.aiTitle);
    else if (!firstPrompt) firstPrompt = usageSessionTitle(codeBuddyUserText(row));
    if (typeof row.type !== "string" || !NATIVE_MESSAGE_TYPES.has(row.type)) continue;
    sessionId ??= row.sessionId;
    cwd ??= row.cwd;
    const data = record(row.providerData);
    const id = typeof data.messageId === "string" ? data.messageId : "";
    if (!id || Object.keys(record(data.rawUsage)).length === 0) continue;
    messages.set(id, { data, at: messages.get(id)?.at ?? nativeTimeMs(row.timestamp) });
  }
  const entries: HarnessUsageEntry[] = [];
  for (const [id, { data, at }] of messages) {
    const request = providerUsageRequest(id, data, false);
    const entry = request && at !== null && usageEntryFromRequest(request, at);
    if (entry) {
      const credits = record(data.rawUsage).credit;
      if (typeof credits === "number" && Number.isFinite(credits) && credits >= 0) {
        entry.credits = credits;
      }
      entries.push(
        withUsageSession(entry, {
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          cwd: typeof cwd === "string" ? cwd : undefined,
          title: customTitle ?? generatedTitle ?? firstPrompt,
        }),
      );
    }
  }
  return entries;
}

export function createCodeBuddyUsageStatistics(
  environment: NodeJS.ProcessEnv,
  profile: CodeBuddyRuntimeProfile,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    // projects/<project>/<session>.jsonl and <session>/subagents/*.jsonl
    listSources: (signal: AbortSignal) =>
      jsonlUsageSources(
        path.join(codeBuddyConfigRoot(environment, profile), "projects"),
        3,
        signal,
      ),
    readSource: (id: string, signal: AbortSignal) => readCodeBuddyUsage(id, signal),
  });
}
