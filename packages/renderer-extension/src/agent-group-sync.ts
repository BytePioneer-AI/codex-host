import type { HarnessDisplaySet, HarnessDisplaySettings } from "@codexhost/shared-contracts";
import type { AgentGroupPreferenceStore } from "./agent-group-preference.js";

export interface AgentGroupClient {
  getHarnessDisplaySettings?(): Promise<HarnessDisplaySettings>;
  setHarnessDisplaySettings?(input: HarnessDisplaySet): Promise<HarnessDisplaySettings>;
  getHarnessDisplayCapabilities?(): Promise<{ events: boolean }>;
  subscribeHarnessDisplaySettings?(listener: () => void): () => void;
}

/** Host-confirmed snapshots; only explicitly legacy connections use periodic reads. */
export function startAgentGroupSync(
  store: AgentGroupPreferenceStore,
  getClient: () => AgentGroupClient | null,
  options: { migrateLegacy: boolean; intervalMs?: number; owner?: Window },
): (() => void) & { connect(): void } {
  const owner = options.owner ?? (typeof window === "undefined" ? undefined : window);
  let disposed = false;
  let client: AgentGroupClient | null | undefined;
  let generation = 0;
  let stopConnection = () => {};
  let refreshCurrent = () => {};
  const connect = () => {
    const next = getClient();
    if (disposed || next === client) return;
    stopConnection();
    client = next;
    const epoch = ++generation;
    let closed = false;
    let busy = false;
    let dirty = false;
    let writing = false;
    let writeFailed = false;
    let migrated = false;
    let revision = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const valid = () => !closed && !disposed && epoch === generation && next === getClient();
    store.setSyncStatus("loading");
    const refresh = async () => {
      dirty = true;
      if (busy || writing || !valid()) return;
      busy = true;
      try {
        while (dirty && valid() && !writing) {
          dirty = false;
          const readRevision = revision;
          if (!next?.getHarnessDisplaySettings) throw new Error("Host unavailable");
          let result = await next.getHarnessDisplaySettings();
          if (!valid()) return;
          if (!migrated && result.entries === null && options.migrateLegacy) {
            if (!next.setHarnessDisplaySettings) throw new Error("Host unavailable");
            result = await next.setHarnessDisplaySettings({
              entries: store.legacyEntries(),
              initializeOnly: true,
            });
          }
          migrated = true;
          if (!valid()) return;
          if (revision !== readRevision || writing) {
            dirty = true;
            continue;
          }
          store.replace(result.entries ?? []);
          store.setSyncStatus(writeFailed ? "error" : "ready");
        }
      } catch {
        if (valid()) store.setSyncStatus("error");
      } finally {
        busy = false;
        if (dirty && valid() && !writing) void refresh();
      }
    };
    refreshCurrent = () => {
      void refresh();
    };
    // Register first, including synchronous reconnect notifications.
    const remove = next?.subscribeHarnessDisplaySettings?.(refreshCurrent);
    stopConnection = () => {
      closed = true;
      clearInterval(timer);
      remove?.();
    };
    store.setWriter((entries) => {
      if (writing || !valid()) return;
      writing = true;
      revision++;
      store.setSyncStatus("saving");
      void (async () => {
        try {
          if (!next?.setHarnessDisplaySettings) throw new Error("Host unavailable");
          const result = await next.setHarnessDisplaySettings({ entries });
          if (!valid()) return;
          store.replace(result.entries ?? []);
          writeFailed = false;
          store.setSyncStatus("ready");
        } catch {
          if (valid()) {
            writeFailed = true;
            store.setSyncStatus("error");
          }
        } finally {
          writing = false;
          if (dirty && valid()) void refresh();
        }
      })();
    });
    const compatibility = () => {
      remove?.();
      if (valid())
        timer = setInterval(() => {
          connect();
          void refresh();
        }, options.intervalMs ?? 3_000);
    };
    if (!next?.getHarnessDisplayCapabilities || !remove) compatibility();
    else
      void next
        .getHarnessDisplayCapabilities()
        .then((capabilities) => {
          if (!capabilities.events) compatibility();
        })
        .catch((error: unknown) => {
          // A transport failure does not prove that the owner is a legacy Host.
          if ((error as { code?: number })?.code === -32601) compatibility();
        });
    void refresh();
  };
  const recover = () => {
    connect();
    refreshCurrent();
  };
  const visible = () => {
    if (owner?.document.visibilityState === "visible") recover();
  };
  owner?.addEventListener("focus", recover);
  owner?.document.addEventListener("visibilitychange", visible);
  connect();
  return Object.assign(
    () => {
      disposed = true;
      generation++;
      stopConnection();
      owner?.removeEventListener("focus", recover);
      owner?.document.removeEventListener("visibilitychange", visible);
      store.setWriter(null);
      store.setSyncStatus("loading");
    },
    { connect },
  );
}
