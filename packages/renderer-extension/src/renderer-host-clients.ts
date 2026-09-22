import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererModelClient, type RendererModelClient } from "./renderer-model-client.js";
import { installRendererExternalQueue } from "./renderer-external-queue.js";
import { installRendererExternalSteering } from "./renderer-external-steering.js";

/** Model clients follow native connection identities, never the active Composer.
 * A captured client may finish an in-flight request after replacement, but may
 * not dispatch another request through a retired manager. */
export function createRendererHostClients(readRouting: () => RendererHostRouting | undefined) {
  let disposed = false;
  const entries = new Map<
    string,
    {
      route: RendererHostRoute;
      client: RendererModelClient;
      cleanups: (() => void)[];
    }
  >();
  const retire = (hostId: string): void => {
    const entry = entries.get(hostId);
    entries.delete(hostId);
    for (const cleanup of entry?.cleanups ?? []) {
      try {
        cleanup();
      } catch {
        /* Release the remaining hooks too. */
      }
    }
  };
  const forRoute = (route: RendererHostRoute | null): RendererModelClient | null => {
    if (disposed || !route) return null;
    const cached = entries.get(route.hostId);
    if (cached?.route === route) return cached.client;
    retire(route.hostId);
    const target = route.manager;
    const client = createRendererModelClient([
      {
        sendRequest(method, params) {
          if (disposed || readRouting()?.forHost(route.hostId) !== route) {
            throw new Error(`Renderer request manager is unavailable for Host ${route.hostId}`);
          }
          return target.sendRequest(method, params);
        },
        ...(target.addNotificationCallback
          ? { addNotificationCallback: target.addNotificationCallback.bind(target) }
          : {}),
      },
    ]);
    if (!client) return null;
    const cleanups: (() => void)[] = [];
    entries.set(route.hostId, { route, client, cleanups });
    try {
      for (const install of [installRendererExternalQueue, installRendererExternalSteering]) {
        const cleanup = install(target);
        if (cleanup) cleanups.push(cleanup);
      }
    } catch (error) {
      retire(route.hostId);
      throw error;
    }
    return client;
  };
  return {
    forRoute,
    forHost(hostId: string): RendererModelClient | null {
      if (disposed) return null;
      const route = readRouting()?.forHost(hostId) ?? null;
      if (!route) retire(hostId);
      return forRoute(route);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hostId of entries.keys()) retire(hostId);
    },
  };
}
