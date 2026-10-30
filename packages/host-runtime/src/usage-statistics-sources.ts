import { setTimeout as delay } from "node:timers/promises";
import type {
  HarnessUsageEntry,
  HarnessUsageSource,
  HarnessUsageStatisticsCapability,
} from "@codexhost/harness-adapter";
import {
  HarnessUsageSourceChangedError,
  parseHarnessUsageEntry,
} from "@codexhost/harness-adapter/usage-statistics";

type SourceRead = { source: HarnessUsageSource } & (
  { entries: readonly HarnessUsageEntry[] } | { error: unknown } | { removed: true }
);

/** Retry only changed sources, after finishing reads tied to the current listing. */
export async function* readUsageStatisticsSources(
  capability: HarnessUsageStatisticsCapability,
  sources: readonly HarnessUsageSource[],
  signal: AbortSignal,
): AsyncGenerator<SourceRead> {
  let pending = sources;
  for (let attempt = 0; ; attempt++) {
    const changed: HarnessUsageSource[] = [];
    for (const source of pending) {
      signal.throwIfAborted();
      try {
        const entries = (await capability.readSource(source.id, signal))
          .map(parseHarnessUsageEntry)
          .filter((entry): entry is HarnessUsageEntry => entry !== null);
        yield { source, entries };
      } catch (error) {
        signal.throwIfAborted();
        if (HarnessUsageSourceChangedError.is(error) && attempt < 2) changed.push(source);
        else yield { source, error };
      }
    }
    if (!changed.length) return;
    await delay(50 * (attempt + 1), undefined, { signal });
    let current: Map<string, HarnessUsageSource>;
    try {
      current = new Map(
        (await capability.listSources(signal)).map((source) => [source.id, source]),
      );
    } catch (error) {
      signal.throwIfAborted();
      for (const source of changed) yield { source, error };
      return;
    }
    const next: HarnessUsageSource[] = [];
    for (const source of changed) {
      const fresh = current.get(source.id);
      if (fresh) next.push(fresh);
      else yield { source, removed: true };
    }
    pending = next;
  }
}
