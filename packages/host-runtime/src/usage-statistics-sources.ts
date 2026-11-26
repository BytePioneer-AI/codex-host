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

const READ_CONCURRENCY = 6;

type SettledSourceRead =
  | { source: HarnessUsageSource; entries: readonly HarnessUsageEntry[] }
  | { source: HarnessUsageSource; changed: true }
  | { source: HarnessUsageSource; error: unknown };

/** Retry only changed sources, after finishing reads tied to the current listing. */
export async function* readUsageStatisticsSources(
  capability: HarnessUsageStatisticsCapability,
  sources: readonly HarnessUsageSource[],
  signal: AbortSignal,
): AsyncGenerator<SourceRead> {
  let pending = sources;
  for (let attempt = 0; ; attempt++) {
    const changed: HarnessUsageSource[] = [];
    const inFlight: Array<Promise<SettledSourceRead>> = [];
    let nextIndex = 0;
    const startRead = (source: HarnessUsageSource): Promise<SettledSourceRead> =>
      capability.readSource(source.id, signal).then(
        (raw) => ({
          source,
          entries: raw
            .map(parseHarnessUsageEntry)
            .filter((entry): entry is HarnessUsageEntry => entry !== null),
        }),
        (error: unknown) =>
          HarnessUsageSourceChangedError.is(error) && attempt < 2
            ? { source, changed: true }
            : { source, error },
      );

    while (nextIndex < pending.length && inFlight.length < READ_CONCURRENCY) {
      signal.throwIfAborted();
      const source = pending[nextIndex];
      if (!source) break;
      inFlight.push(startRead(source));
      nextIndex += 1;
    }
    for (let next = inFlight.shift(); next !== undefined; next = inFlight.shift()) {
      signal.throwIfAborted();
      const item = await next;
      signal.throwIfAborted();
      const upcoming = pending[nextIndex];
      if (upcoming) {
        inFlight.push(startRead(upcoming));
        nextIndex += 1;
      }
      if ("changed" in item) changed.push(item.source);
      else yield item;
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
