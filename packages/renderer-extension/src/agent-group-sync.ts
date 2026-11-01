import type { HarnessDisplaySet, HarnessDisplaySettings } from "@codexhost/shared-contracts";
import type { AgentGroupPreferenceStore } from "./agent-group-preference.js";

export interface AgentGroupClient {
  getHarnessDisplaySettings?(): Promise<HarnessDisplaySettings>;
  setHarnessDisplaySettings?(input: HarnessDisplaySet): Promise<HarnessDisplaySettings>;
}

/** Both surfaces poll the same local Host-owned file; no browser-to-Desktop bridge. */
export function startAgentGroupSync(
  store: AgentGroupPreferenceStore,
  getClient: () => AgentGroupClient | null,
  options: { migrateLegacy: boolean; intervalMs?: number },
): () => void {
  let disposed = false;
  let busy = false;
  let writing = false;
  let generation = 0;
  let writeFailed = false;
  store.setSyncStatus("loading");
  const refresh = async (): Promise<void> => {
    if (disposed || busy || writing) return;
    busy = true;
    const current = generation;
    try {
      const client = getClient();
      if (!client?.getHarnessDisplaySettings || !client.setHarnessDisplaySettings)
        throw new Error("Host unavailable");
      let result = await client.getHarnessDisplaySettings();
      if (disposed || current !== generation) return;
      if (result.entries === null && options.migrateLegacy) {
        result = await client.setHarnessDisplaySettings({
          entries: store.legacyEntries(),
          initializeOnly: true,
        });
      }
      if (disposed || current !== generation) return;
      store.replace(result.entries ?? []);
      store.setSyncStatus(writeFailed ? "error" : "ready");
    } catch {
      if (!disposed && current === generation) store.setSyncStatus("error");
    } finally {
      busy = false;
    }
  };
  store.setWriter((entries) => {
    if (writing || disposed) return;
    writing = true;
    generation += 1;
    store.setSyncStatus("saving");
    void (async () => {
      try {
        const client = getClient();
        if (!client?.setHarnessDisplaySettings) throw new Error("Host unavailable");
        const result = await client.setHarnessDisplaySettings({ entries });
        if (disposed) return;
        store.replace(result.entries ?? []);
        writeFailed = false;
        store.setSyncStatus("ready");
      } catch {
        if (!disposed) {
          writeFailed = true;
          store.setSyncStatus("error");
        }
      } finally {
        writing = false;
      }
    })();
  });
  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, options.intervalMs ?? 3_000);
  return () => {
    disposed = true;
    clearInterval(timer);
    store.setWriter(null);
    // Never fall back to unsynchronized local writes after losing the Host.
    store.setSyncStatus("loading");
  };
}
