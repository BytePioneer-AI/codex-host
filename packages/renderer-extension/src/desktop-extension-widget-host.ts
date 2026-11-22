import type { HostExtensionRuntimeEntry } from "@codexhost/shared-contracts";
import { installDesktopExtensionHost } from "./desktop-extension-host.js";
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
}: {
  document: Document;
  getClient: () => WidgetClient | null;
  getLocale: () => string;
}): DesktopExtensionWidgetHost {
  const win = document.defaultView;
  const modules = win && installDesktopExtensionHost(win).modules;
  type Module = NonNullable<ReturnType<NonNullable<typeof modules>["get"]>>;
  const instances = new Map<
    string,
    { module: Module; surface?: ReturnType<typeof createDesktopExtensionSurface> }
  >();
  let observed: readonly HostExtensionRuntimeEntry[] = [];
  let disposed = false;
  let subscribedClient: WidgetClient | null = null;
  let unsubscribe: (() => void) | undefined;
  let pending = false;
  let queued = false;

  const reconcile = (extensions: readonly HostExtensionRuntimeEntry[]) => {
    const desired = new Map<string, { item: HostExtensionRuntimeEntry; module: Module }>();
    for (const item of extensions) {
      const spec = item.manifest.widget;
      const module = spec && modules?.get({ ...item, kind: "widget", path: spec.entry });
      if (module) desired.set(item.id, { item, module });
    }
    for (const [id, { module, surface }] of instances) {
      if (desired.get(id)?.module === module) continue;
      instances.delete(id);
      surface?.dispose();
    }
    for (const [id, { item, module }] of desired) {
      const existing = instances.get(id);
      if (existing) {
        void existing.surface?.refreshSettings(item.settingsRevision).catch(() => undefined);
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
        });
        const record = { module, surface };
        instances.set(id, record);
        void surface
          .mount(() => document.body.append(container))
          .catch(() => {
            // Keep the failed generation retired until disabled/replaced, without retaining its DOM.
            if (instances.get(id) === record) delete (record as { surface?: unknown }).surface;
            surface.dispose();
          });
      } catch (cause) {
        module.report({ error: cause instanceof Error ? cause.message : String(cause) });
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
        if (!disposed && snapshot && client === getClient()) {
          observed = snapshot.extensions;
          reconcile(observed);
        }
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
  const stopModules = modules?.subscribe(() => reconcile(observed));
  const timer = win?.setInterval(refreshVisible, POLL_MS);
  document.addEventListener?.("visibilitychange", refreshVisible);
  refreshVisible();

  return {
    refresh,
    syncLocale() {
      for (const { surface } of instances.values()) surface?.syncLocale();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      stopModules?.();
      document.removeEventListener?.("visibilitychange", refreshVisible);
      if (timer !== undefined) win?.clearInterval(timer);
      for (const { surface } of instances.values()) surface?.dispose();
      instances.clear();
    },
  };
}
