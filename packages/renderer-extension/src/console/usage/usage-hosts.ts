/**
 * Machine selection for the usage statistics page. Each Host aggregates its own machine, so the
 * page reads one Host at a time and this module owns the selector's option list.
 */

export const LOCAL_USAGE_HOST_ID = "local";

/** One machine whose usage the page can read. */
export interface RendererUsageStatisticsHost {
  hostId: string;
  /** Machine name from the connection list; the local Host is named by the page. */
  label?: string;
}

/**
 * Machines the embedding entry can offer. The Desktop adds its connected remote Hosts; the web
 * console has no route to them and omits the provider entirely.
 */
export type RendererUsageStatisticsHostsProvider = () => Promise<
  readonly RendererUsageStatisticsHost[]
>;

export interface UsageHostOption {
  /** Opaque key; the page maps it back to the Host ID. */
  key: string;
  label: string;
}

/**
 * Selector options: the local Host first and always present, then every offered machine under its
 * given name or raw Host ID. The current selection stays visible even when it is no longer
 * offered, so a disconnected Host remains selected and switchable instead of silently changing
 * which machine the numbers describe.
 */
export function usageHostOptions(
  hosts: readonly RendererUsageStatisticsHost[] | undefined,
  localLabel: string,
  selected: string,
): UsageHostOption[] {
  const options: UsageHostOption[] = [{ key: LOCAL_USAGE_HOST_ID, label: localLabel }];
  const seen = new Set([LOCAL_USAGE_HOST_ID]);
  const add = (hostId: string, label: string | undefined): void => {
    if (hostId.length === 0 || seen.has(hostId)) return;
    seen.add(hostId);
    options.push({ key: hostId, label: label !== undefined && label.length > 0 ? label : hostId });
  };
  for (const host of hosts ?? []) add(host.hostId, host.label);
  if (!seen.has(selected)) add(selected, undefined);
  return options;
}

export interface LatestKeyGuard<K> {
  /** Starts a read for `key`; the returned check is true only for the newest one while it matches. */
  begin(key: K): () => boolean;
}

/**
 * Guards an asynchronous per-machine read whose machine the user can change while it runs. A
 * slower response for an earlier machine must not publish over a later one, and a response for a
 * machine that is no longer selected must not publish at all — otherwise one machine's labels
 * would describe another machine's numbers.
 */
export function createLatestKeyGuard<K>(): LatestKeyGuard<K> {
  let generation = 0;
  let key: K | undefined;
  return {
    begin(next: K): () => boolean {
      generation += 1;
      key = next;
      const mine = generation;
      const selected = next;
      return () => generation === mine && Object.is(key, selected);
    },
  };
}
