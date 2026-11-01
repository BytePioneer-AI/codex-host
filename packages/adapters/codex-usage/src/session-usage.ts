import { setTimeout as delay } from "node:timers/promises";
import { parseHostUsage, parseHostUsageRequest, type HostUsage } from "@codexhost/harness-adapter";
import type {
  HarnessSessionUsageCapability,
  HarnessSessionUsageHistory,
} from "@codexhost/harness-adapter/plugin";
import { createCodexUsageStatistics } from "./usage-statistics.js";
import { observeSessionUsage, rolloutTokenSnapshot } from "./session-observation.js";
import { CodexResponseTiming } from "./response-timing.js";
import { object } from "./counters.js";

/** Uses the same request reconciliation as global statistics, but never scans other threads' content. */
export function createCodexSessionUsage(
  environment: NodeJS.ProcessEnv,
  closed: AbortSignal,
): HarnessSessionUsageCapability {
  const timing = new CodexResponseTiming();
  const rawCompleted = "rawResponse/completed";
  let hideRawCompleted = false;
  const live = new Map<string, HostUsage>();
  const cache = new Map<string, { fingerprint: string; history: HarnessSessionUsageHistory }>();
  return {
    requestOptions({ method, params, initializeParams }) {
      if (closed.aborted) return null;
      if (method === "initialize") {
        const capabilities = object(params.capabilities);
        const excluded = capabilities?.optOutNotificationMethods;
        hideRawCompleted = false;
        if (capabilities?.experimentalApi !== true || !Array.isArray(excluded)) return null;
        if (!excluded.includes(rawCompleted)) return null;
        hideRawCompleted = true;
        // Desktop excludes raw completions by default. Subscribe for internal metering,
        // while preserving Desktop's exclusion at the downstream forwarding boundary.
        return {
          capabilities: {
            ...capabilities,
            optOutNotificationMethods: excluded.filter((method) => method !== rawCompleted),
          },
        };
      }
      const capabilities = object(initializeParams?.capabilities);
      const excluded = capabilities?.optOutNotificationMethods;
      // Desktop's false is a fixed default, not a user preference. This changes only
      // telemetry on new Threads; resume has no such option. Never force experimental API.
      return method === "thread/start" &&
        capabilities?.experimentalApi === true &&
        !(Array.isArray(excluded) && excluded.includes(rawCompleted)) &&
        (params.experimentalRawEvents === undefined || params.experimentalRawEvents === false)
        ? { experimentalRawEvents: true }
        : null;
    },
    shouldForwardNotification(message) {
      return closed.aborted || !hideRawCompleted || object(message)?.method !== rawCompleted;
    },
    reset() {
      timing.reset();
    },
    observe(message, observedAtMs = Date.now()) {
      if (closed.aborted) return null;
      const observation = observeSessionUsage(message);
      const measured = timing.observe(message, observedAtMs);
      if (observation?.usage) live.set(observation.sessionId, observation.usage);
      return measured ? { ...observation, ...measured } : observation;
    },
    async read(sessionId, signal) {
      signal = AbortSignal.any([signal, closed]);
      signal.throwIfAborted();
      for (let attempt = 0; ; attempt++) {
        let snapshot: HostUsage | null = null;
        let complete = true;
        const reader = createCodexUsageStatistics(environment, {
          sessionId,
          onTokenCount: (info) => {
            snapshot = rolloutTokenSnapshot(info) ?? snapshot;
          },
          onIncomplete: () => {
            complete = false;
          },
        });
        const sources = await reader.listSources(signal);
        const source = sources[0];
        if (!source) return null;
        let history = cache.get(sessionId);
        if (history?.fingerprint !== source.fingerprint) {
          const entries = await reader.readSource(source.id, signal);
          const requests = entries.map((entry) =>
            parseHostUsageRequest({
              requestId: entry.id,
              historical: true,
              ...(entry.model ? { model: entry.model } : {}),
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              ...(entry.cachedInputTokens !== undefined
                ? { cachedInputTokens: entry.cachedInputTokens }
                : {}),
              // Codex/OpenAI cache has no separately billed cache creation bucket.
              cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0,
              ...(entry.reasoningOutputTokens !== undefined
                ? { reasoningOutputTokens: entry.reasoningOutputTokens }
                : {}),
            }),
          );
          const inputTokens = requests.reduce((sum, r) => sum + r.inputTokens, 0);
          const outputTokens = requests.reduce((sum, r) => sum + r.outputTokens, 0);
          const cachedInputTokens = requests.every((r) => r.cachedInputTokens !== undefined)
            ? requests.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0)
            : undefined;
          const last = requests.at(-1);
          const usage = requests.length
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
          history = {
            fingerprint: source.fingerprint,
            history: { usage, requests, complete: complete && requests.length > 0 },
          };
          cache.set(sessionId, history);
        }
        const result = history.history;
        const latest = live.get(sessionId);
        // Native notifications can precede disk flush. Never present a stale partial cost as total.
        const caughtUp =
          !latest ||
          ((latest.inputTokens ?? 0) <= (result.usage?.inputTokens ?? 0) &&
            (latest.outputTokens ?? 0) <= (result.usage?.outputTokens ?? 0));
        if (!caughtUp && attempt < 2) {
          // A bounded flush retry, not a background poller. Never delays native frame forwarding.
          await delay(50 * (attempt + 1), undefined, { signal });
          continue;
        }
        return { ...result, complete: result.complete && caughtUp };
      }
    },
  };
}
