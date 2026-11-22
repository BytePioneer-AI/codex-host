import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { HostExtensionRuntimeEntry } from "@codexhost/shared-contracts";
import type { WebNativeExtensionRpcClient } from "./rpc.ts";
import { createWebExtensionSurface, webExtensionAppearance } from "./surface.ts";
import css from "./surface.module.css";

export function createWebWidgetHost(
  ctx: ClientContext,
  doc: Document,
  rpc: WebNativeExtensionRpcClient,
  importModule: (url: string) => Promise<unknown>,
) {
  const appearance = webExtensionAppearance(ctx);
  const instances = new Map<
    string,
    { entry: HostExtensionRuntimeEntry; surface: ReturnType<typeof createWebExtensionSurface> }
  >();

  return {
    reconcile(extensions: readonly HostExtensionRuntimeEntry[]) {
      const desired = new Map(
        extensions.filter(({ manifest }) => manifest.widget).map((entry) => [entry.id, entry]),
      );
      for (const [id, { entry, surface }] of instances) {
        const next = desired.get(id);
        if (next?.activationId === entry.activationId && next.digest === entry.digest) continue;
        instances.delete(id);
        surface.dispose();
      }
      for (const [id, entry] of desired) {
        const existing = instances.get(id);
        if (existing) {
          void existing.surface.refreshSettings(entry.settingsRevision);
          continue;
        }
        const spec = entry.manifest.widget;
        if (!spec || !doc.body) continue;
        const container = doc.createElement("div");
        container.dataset.cxHostWidget = id;
        container.className = `${css.theme} ${css.widget}`;
        const { activationId, digest, settingsRevision } = entry;
        const surface = createWebExtensionSurface({
          container,
          identity: { id, activationId, digest },
          spec,
          kind: "widget",
          appearance,
          hasBackend: entry.manifest.backend !== undefined,
          settingsRevision,
          rpc,
          importModule,
        });
        instances.set(id, { entry, surface });
        doc.body.append(container);
        void surface.mount().catch((error: unknown) => {
          if (instances.get(id)?.surface !== surface) return;
          console.error(`[host-extension-widget] mount failed (${id})`, error);
          // Keep the failed generation retired until it is disabled or replaced.
          surface.dispose();
        });
      }
    },
    dispose() {
      for (const { surface } of instances.values()) surface.dispose();
      instances.clear();
    },
  };
}
