import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  HarnessUsageEntry,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  jsonlRecords,
  jsonlUsageSources,
  nativeTimeMs,
  usageSessionTitle,
  withUsageSession,
} from "@codexhost/harness-adapter/usage-statistics";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const USD_TICKS = 10_000_000_000;

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Grok Build's folder: `$GROK_HOME`, else `~/.grok`. */
export function grokHome(environment: NodeJS.ProcessEnv): string {
  return environment.GROK_HOME || path.join(environment.HOME || os.homedir(), ".grok");
}

/** When a forked or restored session was made; its earlier turns are copies of its source's. */
async function grokSummary(
  directory: string,
): Promise<{ forkedAt: number | null; title?: string }> {
  try {
    const summary: unknown = JSON.parse(
      await readFile(path.join(directory, "summary.json"), "utf8"),
    );
    if (!isRecord(summary)) return { forkedAt: null };
    const title =
      usageSessionTitle(summary.generated_title) ?? usageSessionTitle(summary.session_summary);
    return {
      forkedAt:
        typeof summary.parent_session_id === "string" ? nativeTimeMs(summary.created_at) : null,
      ...(title ? { title } : {}),
    };
  } catch {
    return { forkedAt: null };
  }
}

/** The session folder names the session; its parent folder is the URL-encoded working directory. */
function grokSession(file: string): { sessionId: string; cwd: string | undefined } {
  const directory = path.dirname(file);
  let cwd: string | undefined;
  try {
    cwd = decodeURIComponent(path.basename(path.dirname(directory)));
  } catch {
    cwd = undefined;
  }
  return { sessionId: path.basename(directory), cwd };
}

/**
 * Every Turn's usage in one Grok session's `updates.jsonl`, one entry per prompt and model from
 * `turn_completed` `usage.modelUsage`. Verified on local sessions: input includes cache reads
 * (as the live cache rate reads it), output includes reasoning, and `totalTokens` is their sum.
 * Cache writes were always 0; a nonzero one has unverified semantics, so its cache counts are
 * left unknown. A fork starts with copies of its source's turns (same prompt ID, rewritten time):
 * those up to its creation are left out, and the Host's dedup catches the rest.
 */
export async function readGrokUsage(
  file: string,
  signal: AbortSignal,
): Promise<HarnessUsageEntry[]> {
  const summary = await grokSummary(path.dirname(file));
  const forkedAt = summary.forkedAt;
  let title = summary.title;
  const session = grokSession(file);
  const entries: HarnessUsageEntry[] = [];
  for await (const line of jsonlRecords(file, '"sessionUpdate"', signal)) {
    const params = isRecord(line.params) ? line.params : {};
    const update = isRecord(params.update) ? params.update : {};
    if (!title && update.sessionUpdate === "user_message_chunk") {
      title = usageSessionTitle(isRecord(update.content) ? update.content.text : undefined);
      continue;
    }
    const usage = isRecord(update.usage) ? update.usage : {};
    if (update.sessionUpdate !== "turn_completed" || typeof update.prompt_id !== "string") continue;
    const meta = isRecord(params._meta) ? params._meta : {};
    const at =
      nativeTimeMs(meta.agentTimestampMs) ??
      (typeof line.timestamp === "number" ? nativeTimeMs(line.timestamp * 1000) : null);
    if (at === null || (forkedAt !== null && at <= forkedAt)) continue;
    for (const [model, value] of Object.entries(
      isRecord(usage.modelUsage) ? usage.modelUsage : {},
    )) {
      if (!isRecord(value)) continue;
      const input = count(value.inputTokens);
      const output = count(value.outputTokens);
      const cached = count(value.cachedReadTokens);
      const written = count(value.cacheCreationTokens ?? 0);
      const reasoning = count(value.reasoningTokens);
      // What Grok recorded the turn cost, in xAI's ticks of 1e-10 USD.
      const ticks = count(value.costUsdTicks);
      if (input === null || output === null || value.totalTokens !== input + output) continue;
      const cacheKnown = cached !== null && cached <= input && written === 0;
      entries.push(
        withUsageSession(
          {
            id: `${update.prompt_id}:${model}`,
            occurredAtMs: at,
            model,
            inputTokens: input,
            ...(cacheKnown ? { cachedInputTokens: cached, cacheWriteInputTokens: 0 } : {}),
            outputTokens: output,
            ...(reasoning !== null && reasoning <= output
              ? { reasoningOutputTokens: reasoning }
              : {}),
            // A turn Grok marks incomplete has no cost of its own; it counts as free rather
            // than as a model without a price.
            ...(ticks !== null
              ? { costUsd: ticks / USD_TICKS }
              : usage.usageIsIncomplete === true
                ? { costUsd: 0 }
                : {}),
          },
          { ...session, ...(title ? { title } : {}) },
        ),
      );
    }
  }
  return entries;
}

export function createGrokUsageStatistics(
  environment: NodeJS.ProcessEnv,
): HarnessUsageStatisticsCapability {
  return Object.freeze({
    // sessions/<url-encoded cwd>/<session>/updates.jsonl; subagents are sessions of their own.
    listSources: async (signal: AbortSignal) =>
      (await jsonlUsageSources(path.join(grokHome(environment), "sessions"), 2, signal)).filter(
        (source) => path.basename(source.id) === "updates.jsonl",
      ),
    readSource: (id: string, signal: AbortSignal) => readGrokUsage(id, signal),
  });
}
