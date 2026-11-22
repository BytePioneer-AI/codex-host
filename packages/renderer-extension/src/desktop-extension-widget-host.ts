import type { HostExtensionRuntimeEntry } from "@codexhost/shared-contracts";
import { createDesktopExtensionSurface } from "./desktop-extension-surface.js";
import type { RendererModelClient } from "./renderer-model-client.js";

type WidgetClient = Pick<
  RendererModelClient,
  | "snapshotHostExtensions"
  | "subscribeHostExtensionsChanged"
  | "readHostExtensionAsset"
  | "getHostExtensionSettings"
  | "setHostExtensionSettings"
  | "invokeHostExtensionBackend"
>;

export interface DesktopExtensionWidgetHost {
  refresh(): void;
  syncLocale(): void;
  dispose(): void;
}

const POLL_MS = 5_000;

export function createDesktopExtensionWidgetHost({
  document,
  getClient,
  getLocale,
  importModule,
}: {
  document: Document;
  getClient: () => WidgetClient | null;
  getLocale: () => string;
  importModule?: (url: string) => Promise<unknown>;
}): DesktopExtensionWidgetHost {
  const instances = new Map<
    string,
    { item: HostExtensionRuntimeEntry; surface: ReturnType<typeof createDesktopExtensionSurface> }
  >();
  let disposed = false;
  let subscribedClient: WidgetClient | null = null;
  let unsubscribe: (() => void) | undefined;
  let pending = false;
  let queued = false;

  const reconcile = (extensions: readonly HostExtensionRuntimeEntry[]) => {
    const desired = new Map(
      extensions.filter(({ manifest }) => manifest.widget).map((item) => [item.id, item]),
    );
    for (const [id, { item, surface }] of instances) {
      const next = desired.get(id);
      if (next?.activationId === item.activationId && next.digest === item.digest) continue;
      instances.delete(id);
      surface.dispose();
    }
    for (const [id, item] of desired) {
      const existing = instances.get(id);
      if (existing) {
        void existing.surface.refreshSettings(item.settingsRevision).catch(() => undefined);
        continue;
      }
      const spec = item.manifest.widget;
      if (!spec || !document.body) continue;
      try {
        const container = document.createElement("div");
        container.dataset.cxHostWidget = id;
        Object.assign(container.style, {
          position: "fixed",
          inset: "0",
          pointerEvents: "none",
          zIndex: "900",
        });
        const surface = createDesktopExtensionSurface({
          container,
          item,
          spec,
          kind: "widget",
          getClient,
          getLocale,
          importModule,
        });
        instances.set(id, { item, surface });
        void surface
          .mount(() => document.body.append(container))
          .catch(() => {
            // Keep the failed generation retired until it is disabled or replaced.
            surface.dispose();
          });
      } catch {
        // Failure to initialize one widget does not prevent others from mounting.
      }
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    const client = getClient();
    if (client !== subscribedClient) {
      unsubscribe?.();
      subscribedClient = client;
      unsubscribe = client?.subscribeHostExtensionsChanged?.(refresh);
    }
    if (!client?.snapshotHostExtensions) return;
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    void (async () => {
      try {
        const snapshot = await client.snapshotHostExtensions?.();
        if (!disposed && snapshot && client === getClient()) reconcile(snapshot.extensions);
      } catch {
        // Keep existing widgets on transient RPC errors and try again on the next refresh.
      } finally {
        pending = false;
        if (queued) {
          queued = false;
          refresh();
        }
      }
    })();
  };

  const refreshVisible = () => {
    if (!document.hidden) refresh();
  };
  const win = document.defaultView;
  const timer = win?.setInterval(refreshVisible, POLL_MS);
  document.addEventListener?.("visibilitychange", refreshVisible);
  refreshVisible();

  return {
    refresh,
    syncLocale() {
      for (const { surface } of instances.values()) surface.syncLocale();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      document.removeEventListener?.("visibilitychange", refreshVisible);
      if (timer !== undefined) win?.clearInterval(timer);
      for (const { surface } of instances.values()) surface.dispose();
      instances.clear();
    },
  };
}
