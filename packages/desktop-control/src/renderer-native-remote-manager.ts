import type {
  NativeRpcComponents,
  NativeRpcManager,
  NativeRequestClient,
  NativeOwnedManager,
} from "./renderer-native-rpc-contracts.js";
import type {
  createDraftPrewarmPolicyBridge,
  DraftPrewarmPolicyTarget,
} from "./renderer-draft-prewarm-runtime.js";
import type { createNativeRpcChannel } from "./renderer-native-rpc-channel.js";
import type { retainNativeRpcInteractions } from "./renderer-native-rpc-interactions.js";

/** Own one native Renderer manager and one bridge for a physical connection.
 * Logical requests use Desktop's queue; tunnel control must bypass that queue. */
export function createNativeRemoteManager(
  components: NativeRpcComponents,
  hostId: string,
  original: NativeRpcManager,
  target: DraftPrewarmPolicyTarget,
  createPolicy: typeof createDraftPrewarmPolicyBridge,
  createChannel: typeof createNativeRpcChannel,
  retainInteractions: typeof retainNativeRpcInteractions,
) {
  const source = components.scope.get(components.requestDefinition, hostId) as NativeRequestClient;
  const upstream = original.dup();
  let manager: NativeOwnedManager | undefined;
  let policy: ReturnType<typeof createPolicy> | undefined;
  let interactions: ReturnType<typeof retainInteractions> | undefined;
  let disposed = false;
  const pending = new Set<Promise<unknown>>();
  const send = (method: string, params: unknown, options?: unknown): Promise<unknown> => {
    const request = upstream.sendRequest(method, params, options);
    const result = Promise.resolve(request).finally(() => {
      request[Symbol.dispose]();
      pending.delete(result);
    });
    pending.add(result);
    return result;
  };
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  const dispatch = (type: string, payload: unknown): unknown => {
    if (
      (type === "mcp-request" || type === "thread-prewarm-start") &&
      record(payload) &&
      record(payload.request)
    ) {
      const request = payload.request;
      const options: Record<string, unknown> = {};
      for (const key of ["priority", "timeoutMs", "source", "trace", "threadAccess"])
        if (payload[key] !== undefined) options[key] = payload[key];
      void send(String(request.method), request.params, options).then(
        (result) => {
          if (!disposed) client.onResult(request.id, result);
        },
        (error: unknown) => {
          if (!disposed)
            client.onError(request.id, {
              code: record(error) ? (error.jsonRpcCode ?? error.code ?? -32603) : -32603,
              message: error instanceof Error ? error.message : String(error),
            });
        },
      );
      return;
    }
    return source.dispatchMessage(type, payload);
  };
  const Constructor = source.constructor as new (
    hostId: string,
    sender: typeof dispatch,
    diagnostics: boolean,
    access: (id: string) => unknown,
  ) => NativeRequestClient;
  let client: NativeRequestClient;
  try {
    client = new Constructor(
      hostId,
      dispatch,
      false,
      (id) => manager?.getConversation(id)?.threadAccess,
    );
    client.setAppServerVersion(source.getAppServerVersion());
    manager = components.createManager(
      components.scope,
      hostId,
      client,
      components.isHostForConversation.bind(null, components.scope),
      (get, id) => get(components.imageDefinition, id),
      { dispatchMessageFromView: dispatch },
    );
    // New Desktop approvals call this member directly; the bridge intercepts
    // dispatchAppServerResponse. Both names must reach the same owned responder.
    manager.dispatchAppServerResponse = manager.sendAppServerResponse;
    const owned = manager;
    const ownedPolicy = createPolicy(
      owned,
      client,
      hostId,
      target,
      owned.prewarmedThreadManager,
      () => !disposed,
      undefined,
      undefined,
      (method, params) => send(method, params, { priority: "critical" }),
    );
    policy = ownedPolicy;
    owned.sendAppServerResponse = (...args) => owned.dispatchAppServerResponse(...args);
    const channel = createChannel(components, owned);
    const nativeInteractions = retainInteractions(upstream, owned, hostId);
    interactions = nativeInteractions;
    const notify = (event: Event): void => {
      const { data, source, origin } = event as Event & {
        data?: unknown;
        source?: unknown;
        origin?: unknown;
      };
      // Preload dispatches trusted native events with a null source. Reject
      // other windows while preserving Desktop's preload message boundary.
      if (
        disposed ||
        (source != null && source !== target) ||
        !record(data) ||
        data.hostId !== hostId
      )
        return;
      const ownOrigin = record(target.location) ? target.location.origin : undefined;
      if (source === target && ownOrigin && ownOrigin !== "null" && origin !== ownOrigin) return;
      if (
        data.type === "mcp-notification" &&
        typeof data.method === "string" &&
        !data.method.startsWith("process/")
      )
        owned.onNotification(data.method, data.params);
      if (data.type === "mcp-request") owned.onRequest(record(data.request) ? data.request : data);
    };
    target.addEventListener?.("message", notify);
    return {
      route: { hostId, manager: owned, policy: ownedPolicy },
      rpc: channel.rpc,
      ready: nativeInteractions.ready,
      dispose() {
        if (disposed) return;
        disposed = true;
        target.removeEventListener?.("message", notify);
        nativeInteractions.dispose();
        ownedPolicy.dispose();
        client.queuedRequests.length = 0;
        for (const id of [...client.requestPromises.keys()])
          client.onError(id, new Error("Remote Control connection retired"));
        channel.dispose();
        components.Manager.dispose(owned);
        // Keep the original RPC handle alive until the bridge's final kill/write
        // completes. Disposing it first invalidates process handles mid-request.
        void Promise.allSettled([...pending]).then(() => upstream[Symbol.dispose]());
      },
    };
  } catch (error) {
    interactions?.dispose();
    policy?.dispose();
    if (manager) components.Manager.dispose(manager);
    upstream[Symbol.dispose]();
    throw error;
  }
}
