import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import {
  createRendererModelClient,
  THREAD_USAGE_UPDATED_METHOD,
  type RendererModelClient,
} from "./renderer-model-client.js";
import { installRendererExternalQueue } from "./renderer-external-queue.js";
import { installRendererExternalSteering } from "./renderer-external-steering.js";
import { installRendererNativeResume } from "./renderer-native-resume.js";
import { createRemoteAttachmentSender } from "./renderer-remote-attachments.js";
import { restoreThreadReferenceCapability } from "./renderer-thread-reference-capability.js";
import {
  installRendererManualCompaction,
  type RendererMessageTarget,
} from "./renderer-manual-compaction.js";

/** Model clients follow native connection identities, never the active Composer.
 * A captured client may finish an in-flight request after replacement, but may
 * not dispatch another request through a retired manager. */
export function createRendererHostClients(
  readRouting: () => RendererHostRouting | undefined,
  messages: RendererMessageTarget | null = null,
) {
  let disposed = false;
  const entries = new Map<
    string,
    {
      route: RendererHostRoute;
      client: RendererModelClient;
      cleanups: Set<() => void>;
    }
  >();
  const retire = (hostId: string): void => {
    const entry = entries.get(hostId);
    entries.delete(hostId);
    for (const cleanup of (entry?.cleanups ?? []).slice().reverse()) {
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
    const cleanups = new Set<() => void>();
    const nativeClient = createRendererModelClient([
      {
        sendRequest(method, params, options) {
          if (disposed || readRouting()?.forHost(route.hostId) !== route) {
            throw new Error(`Renderer request manager is unavailable for Host ${route.hostId}`);
          }
          if (method === "thread/resume" && options === undefined && target.resumeThread) {
            return target.resumeThread(params);
          }
          return options === undefined
            ? target.sendRequest(method, params)
            : target.sendRequest(method, params, options);
        },
        ...(target.addNotificationCallback
          ? {
              addNotificationCallback(
                methods: string | readonly string[],
                listener: (notification: unknown) => void,
              ) {
                const unsubscribe = target.addNotificationCallback?.(methods, listener);
                if (
                  !messages ||
                  !(typeof methods === "string" ? [methods] : methods).includes(
                    THREAD_USAGE_UPDATED_METHOD,
                  )
                )
                  return () => unsubscribe?.();
                // Like manual compaction, observe the real Host frame before Desktop's
                // app-server method table drops custom notifications. No synthetic Tokens.
                const onMessage: Parameters<RendererMessageTarget["addEventListener"]>[1] = (
                  event,
                ) => {
                  if (event.source != null && event.source !== messages) return;
                  const message = event.data;
                  if (
                    disposed ||
                    !message ||
                    typeof message !== "object" ||
                    !("type" in message) ||
                    message.type !== "mcp-notification" ||
                    !("hostId" in message) ||
                    message.hostId !== route.hostId ||
                    !("method" in message) ||
                    message.method !== THREAD_USAGE_UPDATED_METHOD ||
                    readRouting()?.forHost(route.hostId) !== route
                  )
                    return;
                  listener(message);
                };
                const remove = () => {
                  messages.removeEventListener("message", onMessage);
                  cleanups.delete(remove);
                };
                messages.addEventListener("message", onMessage);
                cleanups.add(remove);
                return () => {
                  remove();
                  unsubscribe?.();
                };
              },
            }
          : {}),
      },
    ]);
    if (!nativeClient) return null;
    const client = restoreThreadReferenceCapability(
      nativeClient,
      target,
      () => !disposed && readRouting()?.forHost(route.hostId) === route,
    );
    entries.set(route.hostId, { route, client, cleanups });
    try {
      for (const install of [
        () =>
          installRendererNativeResume(
            target,
            () => !disposed && readRouting()?.forHost(route.hostId) === route,
          ),
        () => installRendererExternalQueue(target),
        () =>
          installRendererExternalSteering(
            target,
            createRemoteAttachmentSender(
              target,
              route.hostId,
              () => !disposed && readRouting()?.forHost(route.hostId) === route,
            ),
          ),
        () => installRendererManualCompaction(target, route.hostId, messages),
      ]) {
        const cleanup = install();
        if (cleanup) cleanups.add(cleanup);
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
