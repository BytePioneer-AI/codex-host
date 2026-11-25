import type {
  NativeRpcComponents,
  NativeRpcLease,
  NativeRpcManager,
  NativeRpcManagerService,
  NativeRpcResult,
  NativeRpcState,
} from "./renderer-native-rpc-contracts.js";
import type { createNativeRemoteManager } from "./renderer-native-remote-manager.js";
import type { RendererHostRoute } from "./renderer-host-routing.js";

/** Adapt only Windows Remote Control targets. POSIX and ordinary Hosts keep the
 * official manager. Reconnect replaces the whole owned context, never its IDs. */
export function createNativeRpcService(
  components: NativeRpcComponents,
  createRemote: (
    hostId: string,
    upstream: NativeRpcManager,
  ) => ReturnType<typeof createNativeRemoteManager>,
) {
  const source = components.services.appServerManagers.dup();
  const routes = new Map<string, RendererHostRoute | null>();
  const subscriptions = new Set<() => void>();
  let refs = 1;
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  const connectionSignals = (hostId: string) => {
    let node = components.scope.node;
    const seen = new Set<object>();
    while (node.parent && !seen.has(node.parent) && seen.size < 100) {
      seen.add(node);
      node = node.parent;
    }
    const found: { state$: unknown; revision$: unknown }[] = [];
    for (const members of node.familyBindings.values()) {
      const value = members.get(hostId)?.value;
      if (
        record(value) &&
        Object.hasOwn(value, "state$") &&
        Object.hasOwn(value, "revision$") &&
        Object.hasOwn(value, "appServerVersion$")
      )
        found.push({ state$: value.state$, revision$: value.revision$ });
    }
    return found.length === 1 ? found[0] : undefined;
  };
  const service: NativeRpcManagerService = {
    dup() {
      refs++;
      return service;
    },
    onRpcBroken(listener) {
      source.onRpcBroken(listener);
    },
    openAccount(hostId) {
      return source.openAccount(hostId);
    },
    subscribe(hostId, listener) {
      if (!hostId.startsWith("remote-control:")) return source.subscribe(hostId, listener);
      let active = true;
      let generation = 0;
      let upstream: NativeRpcManager | undefined;
      let platformRequest: NativeRpcResult<string> | undefined;
      let remote: ReturnType<typeof createRemote> | undefined;
      let stopWatch: (() => void) | undefined;
      let previousRevision: unknown;
      let previousState: unknown;
      const retire = () => {
        generation++;
        platformRequest?.[Symbol.dispose]();
        platformRequest = undefined;
        remote?.dispose();
        remote = undefined;
        routes.set(hostId, null);
      };
      const cleanup = () => {
        if (!active) return;
        active = false;
        stopWatch?.();
        retire();
        upstream?.[Symbol.dispose]();
        upstream = undefined;
        routes.delete(hostId);
        subscriptions.delete(cleanup);
      };
      subscriptions.add(cleanup);
      const publish = async () => {
        const owner = upstream;
        const current = generation;
        if (!owner || !active) return;
        let request: NativeRpcResult<string> | undefined;
        try {
          request = owner.getCodexHome();
          platformRequest = request;
          const home = await request;
          if (!active || current !== generation || owner !== upstream) return;
          if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(home)) {
            routes.delete(hostId);
            listener({ status: "ready", manager: owner });
            return;
          }
          const created = createRemote(hostId, owner);
          remote = created;
          await created.ready;
          if (!active || current !== generation || owner !== upstream) return;
          routes.set(hostId, created.route);
          listener({ status: "ready", manager: created.rpc });
        } catch {
          if (active && current === generation) {
            // A discovery/construction failure leaves native Codex usable. No
            // repeated optional-Harness probes or hidden retry loop.
            remote?.dispose();
            remote = undefined;
            routes.delete(hostId);
            listener({ status: "ready", manager: owner });
          }
        } finally {
          if (platformRequest === request) {
            platformRequest = undefined;
            request?.[Symbol.dispose]();
          }
        }
      };
      const changed = (state: NativeRpcState) => {
        if (!active) return;
        stopWatch?.();
        stopWatch = undefined;
        retire();
        upstream?.[Symbol.dispose]();
        upstream = undefined;
        if (state.status !== "ready") {
          listener(state);
          return;
        }
        upstream = state.manager.dup();
        listener({ status: "connecting" });
        const signals = connectionSignals(hostId);
        if (!signals) {
          void publish();
          return;
        }
        previousState = undefined;
        previousRevision = undefined;
        stopWatch = components.scope.watch(({ get }) => {
          const connection = get(signals.state$),
            revision = get(signals.revision$);
          if (connection === previousState && revision === previousRevision) return;
          previousState = connection;
          previousRevision = revision;
          retire();
          listener({ status: connection === "connected" ? "connecting" : "disconnected" });
          if (connection === "connected") void publish();
        });
      };
      const original = source.subscribe(hostId, changed);
      // Desktop owns this lease. Its disposal must also stop our scope watcher
      // and retire the process bridge, even if subscribe is still pending.
      const result = original.then((lease): NativeRpcLease => {
        if (!active) lease[Symbol.dispose]();
        return {
          onRpcBroken: (listener) => lease.onRpcBroken(listener),
          [Symbol.dispose]() {
            cleanup();
            lease[Symbol.dispose]();
          },
        };
      });
      Object.assign(result, {
        onRpcBroken: (listener: (error: unknown) => void) => original.onRpcBroken(listener),
        [Symbol.dispose]() {
          cleanup();
          original[Symbol.dispose]();
        },
      });
      return result as NativeRpcResult<NativeRpcLease>;
    },
    [Symbol.dispose]() {
      if (--refs !== 0) return;
      for (const cleanup of [...subscriptions]) cleanup();
      source[Symbol.dispose]();
    },
  };
  return { service, route: (hostId: string) => routes.get(hostId) };
}
