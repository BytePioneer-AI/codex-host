import os from "node:os";
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

import { claudeUsageRecord, isClaudeModelRequest } from "./claude-usage.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function claudeProjectsDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(
    path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")),
    "projects",
  );
}

/**
 * Every message in one transcript, one entry per native `message.id`: the main session's
 * `projects/<project>/<id>.jsonl` and its subagents' `<id>/subagents/**.jsonl` alike. A message
 * repeats its final usage on each of its lines; the first line dates it. A resumed or forked
 * transcript repeats earlier message IDs, which the Host counts once.
 */
export async function readClaudeUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const messages = new Map<string, { model: string; usage: unknown; at: number | null }>();
  // Every line names its session and working directory; a subagent's lines name the parent's.
  let sessionId: unknown;
  let cwd: unknown;
  let customTitle: string | undefined;
  let generatedTitle: string | undefined;
  let firstPrompt: string | undefined;
  for await (const line of jsonlRecords(file, '"type"', signal)) {
    if (line.type === "custom-title") customTitle = usageSessionTitle(line.customTitle);
    else if (line.type === "ai-title") generatedTitle = usageSessionTitle(line.aiTitle);
    else if (line.type === "summary") generatedTitle ??= usageSessionTitle(line.summary);
    else if (!firstPrompt && line.type === "user") firstPrompt = claudeUserPrompt(line.message);
    if (line.type !== "assistant" || !isRecord(line.message)) continue;
    sessionId ??= line.sessionId;
    cwd ??= line.cwd;
    const { id, model, usage } = line.message;
    if (typeof id !== "string" || id.length === 0 || !isClaudeModelRequest(model)) continue;
    const at = messages.get(id)?.at ?? nativeTimeMs(line.timestamp);
    messages.set(id, { model, usage, at });
  }
  const entries: HarnessUsageEntry[] = [];
  for (const [id, { model, usage, at }] of messages) {
    const record = claudeUsageRecord(id, model, usage);
    const entry =
      record.kind === "request" && at !== null && usageEntryFromRequest(record.request, at);
    if (entry)
      entries.push(
        withUsageSession(entry, {
          sessionId: text(sessionId),
          cwd: text(cwd),
          title: customTitle ?? generatedTitle ?? firstPrompt,
        }),
      );
  }
  return entries;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function claudeUserPrompt(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "user") return undefined;
  const { content } = message;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
            )
            .map((block) => String(block.text))
            .join(" ")
        : "";
  const title = usageSessionTitle(raw);
  return title && !/^<(?:local-command-|command-)/u.test(title) ? title : undefined;
}

export function createClaudeUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    // projects/<project>/<id>.jsonl, <id>/subagents/*.jsonl, <id>/subagents/workflows/wf_*/*.jsonl
    listSources: (signal: AbortSignal) =>
      jsonlUsageSources(claudeProjectsDirectory(environment), 4, signal),
    readSource: (id: string, signal: AbortSignal) => readClaudeUsage(id, signal),
  });
}
