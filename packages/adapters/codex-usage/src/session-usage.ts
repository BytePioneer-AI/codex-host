import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseHostUsageRequest, type HostUsage } from "@codexhost/harness-adapter";
import type { HarnessSessionUsageCapability } from "@codexhost/harness-adapter/plugin";
import { createCodexSessionHistoryReader } from "./session-history.js";
import { observeSessionUsage } from "./session-observation.js";
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
  const reader = createCodexSessionHistoryReader(environment);
  const home = resolve(
    environment.CODEX_HOME ||
      join(environment.HOME || environment.USERPROFILE || homedir(), ".codex"),
  );
  let canonicalHome = home;
  try {
    canonicalHome = realpathSync(home);
  } catch {
    /* A missing home has no history yet. */
  }
  return {
    measurementScope: `codex-usage:${canonicalHome}`,
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
        const history = await reader.read(sessionId, signal);
        if (!history) return null;
        const requests = history.entries.map((entry) =>
          parseHostUsageRequest({
            requestId: entry.id,
            historical: true,
            ...(entry.model ? { model: entry.model } : {}),
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            ...(entry.cachedInputTokens !== undefined
              ? { cachedInputTokens: entry.cachedInputTokens }
              : {}),
            cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0,
            ...(entry.reasoningOutputTokens !== undefined
              ? { reasoningOutputTokens: entry.reasoningOutputTokens }
              : {}),
          }),
        );
        const result = {
          usage: history.usage,
          requests,
          complete: history.complete && requests.length > 0,
          retainedTurnIds: history.retainedTurnIds,
          ...(history.lastTurnTiming ? { lastTurnTiming: history.lastTurnTiming } : {}),
        };
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
