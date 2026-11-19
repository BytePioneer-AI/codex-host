import { parseHostUsage, type HostUsage, type HarnessUsageEntry } from "@codexhost/harness-adapter";
import { createCodexUsageStatistics } from "./usage-statistics.js";
import { object } from "./counters.js";
import { rolloutTokenSnapshot } from "./session-observation.js";

interface Dependency {
  sessionId: string;
  fingerprint: string;
}
export interface CodexSessionHistory {
  entries: readonly HarnessUsageEntry[];
  usage: HostUsage | null;
  complete: boolean;
  retainedTurnIds: string[];
  lastTurnTiming?: { turnId: string; timeToFirstOutputMs: number; at: number };
  dependencies: Dependency[];
}

/** Session totals include a native fork's inherited prefix; global billing attribution does not. */
export function createCodexSessionHistoryReader(environment: NodeJS.ProcessEnv) {
  const cache = new Map<string, CodexSessionHistory>();
  const sourceFingerprint = async (sessionId: string, signal: AbortSignal) =>
    (await createCodexUsageStatistics(environment, { sessionId }).listSources(signal))[0]
      ?.fingerprint;
  const read = async (
    sessionId: string,
    signal: AbortSignal,
    limit?: number,
    ancestors: string[] = [],
  ): Promise<CodexSessionHistory | null> => {
    if (ancestors.includes(sessionId) || ancestors.length >= 16)
      throw new Error("Invalid Codex history ancestry");
    const key = JSON.stringify([sessionId, limit]);
    const cached = cache.get(key);
    if (cached) {
      const matches = await Promise.all(
        cached.dependencies.map(
          async (d) => (await sourceFingerprint(d.sessionId, signal)) === d.fingerprint,
        ),
      );
      if (matches.every(Boolean)) return cached;
    }
    let complete = true;
    let snapshot: HostUsage | null = null;
    let inherited: Record<string, unknown> | undefined;
    let lastTurnTiming: CodexSessionHistory["lastTurnTiming"];
    const turns = new Set<string>();
    const reader = createCodexUsageStatistics(environment, {
      sessionId,
      ...(limit === undefined ? {} : { endOrdinalExclusive: limit }),
      onIncomplete: () => {
        complete = false;
      },
      onInheritedHistory: (metadata) => {
        inherited = metadata;
      },
      onTokenCount: (info) => {
        snapshot = rolloutTokenSnapshot(info) ?? snapshot;
      },
      onTurnId: (id) => {
        turns.add(id);
      },
      onTurnTiming: (turnId, timeToFirstOutputMs, at) => {
        if (!lastTurnTiming || at >= lastTurnTiming.at)
          lastTurnTiming = { turnId, timeToFirstOutputMs, at };
      },
    });
    const source = (await reader.listSources(signal))[0];
    if (!source) return null;
    let entries = await reader.readSource(source.id, signal);
    const dependencies: Dependency[] = [{ sessionId, fingerprint: source.fingerprint }];
    if (inherited) {
      const base = object(inherited.history_base);
      const parentId = base?.thread_id;
      const end = base?.end_ordinal_exclusive;
      if (
        typeof parentId !== "string" ||
        !parentId ||
        typeof end !== "number" ||
        !Number.isSafeInteger(end) ||
        end < 1 ||
        (inherited.forked_from_id && inherited.forked_from_id !== parentId)
      )
        complete = false;
      else {
        try {
          const parent = await read(parentId, signal, end, [...ancestors, sessionId]);
          if (!parent) complete = false;
          else {
            complete &&= parent.complete;
            dependencies.push(...parent.dependencies);
            const merged = new Map<string, HarnessUsageEntry>();
            for (const entry of [...parent.entries, ...entries]) {
              const previous = merged.get(entry.id);
              if (
                previous &&
                [
                  "model",
                  "inputTokens",
                  "outputTokens",
                  "cachedInputTokens",
                  "cacheWriteInputTokens",
                ].some(
                  (field) =>
                    previous[field as keyof HarnessUsageEntry] !==
                    entry[field as keyof HarnessUsageEntry],
                )
              )
                complete = false;
              merged.set(entry.id, entry);
            }
            entries = [...merged.values()];
          }
        } catch {
          signal.throwIfAborted();
          complete = false;
        }
      }
    }
    // An inherited read may overlap a live append to the child; never cache a mixed generation.
    if ((await sourceFingerprint(sessionId, signal)) !== source.fingerprint)
      throw new Error("Codex rollout changed while restoring history");
    const inputTokens = entries.reduce((sum, r) => sum + r.inputTokens, 0);
    const outputTokens = entries.reduce((sum, r) => sum + r.outputTokens, 0);
    const cachedInputTokens = entries.every((r) => r.cachedInputTokens !== undefined)
      ? entries.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0)
      : undefined;
    const last = entries.at(-1);
    const usage = entries.length
      ? parseHostUsage({
          ...(snapshot ?? {}),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(complete && cachedInputTokens !== undefined
            ? { sessionCacheUsage: { inputTokens, cachedInputTokens } }
            : {}),
          ...(last?.inputTokens && last.cachedInputTokens !== undefined
            ? { cacheHitRatePercent: (last.cachedInputTokens / last.inputTokens) * 100 }
            : {}),
        })
      : snapshot;
    const result: CodexSessionHistory = {
      entries,
      usage,
      complete,
      retainedTurnIds: [...turns],
      dependencies,
      ...(lastTurnTiming ? { lastTurnTiming } : {}),
    };
    // Missing ancestry may reappear without changing the child file.
    if (complete) cache.set(key, result);
    else cache.delete(key);
    return result;
  };
  return { read: (sessionId: string, signal: AbortSignal) => read(sessionId, signal) };
}
