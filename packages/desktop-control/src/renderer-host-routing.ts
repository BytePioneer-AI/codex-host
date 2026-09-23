import type {
  discoverRendererHosts,
  resolveRendererHostManager,
  RendererHostDiscovery,
  RendererHostRoot,
  RendererNativeRequestManager,
} from "./renderer-host-discovery.js";
import type {
  createDraftPrewarmPolicyBridge,
  DraftPrewarmPolicyTarget,
  RendererDraftBridgePolicy,
} from "./renderer-draft-prewarm-runtime.js";

export interface RendererHostRoute {
  readonly hostId: string;
  readonly manager: RendererNativeRequestManager;
  readonly policy: RendererDraftBridgePolicy;
}

export interface RendererHostRouting {
  forHost(hostId: string): RendererHostRoute | null;
  hostIdForComposer(composer?: RendererHostRoot): string | null;
  forComposer(composer?: RendererHostRoot): RendererHostRoute | null;
  dispose(): void;
}

/** One policy per native connection, not one connection per active Composer.
 * Native registries remain the source of truth: this map owns only our hooks.
 * Self-contained for injection; dependencies are supplied by the Controller. */
export function installRendererHostRouting(
  root: RendererHostRoot,
  target: DraftPrewarmPolicyTarget,
  discover: typeof discoverRendererHosts,
  resolve: typeof resolveRendererHostManager,
  createPolicy: typeof createDraftPrewarmPolicyBridge,
): RendererHostRouting {
  const existing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
  if (existing) return existing;
  (target.__codexhostDraftPrewarmPolicyV1 as RendererDraftBridgePolicy | undefined)?.dispose?.();
  let disposed = false;
  let lastDiscovery: RendererHostDiscovery | null = null;
  const routes = new Map<
    string,
    {
      route: RendererHostRoute;
      bridge: RendererNativeRequestManager["requestClient"];
      prewarmed: RendererNativeRequestManager["prewarmedThreadManager"];
    }
  >();
  const read = (composer?: RendererHostRoot): RendererHostDiscovery => {
    const source = composer?.matches?.(
      '[data-codex-composer], [contenteditable="true"][role="textbox"]',
    )
      ? { querySelectorAll: () => [composer] }
      : (composer ?? root);
    const discovery = discover(source);
    if (composer) return discovery;
    // Settings may unmount all editors. Retain the last native registry, but
    // still resolve its current entry on every request (never cache that entry).
    if (discovery.editorCount === 0 && lastDiscovery) return lastDiscovery;
    lastDiscovery = discovery;
    return discovery;
  };
  const lookup = (
    hostId: string,
    discovery?: RendererHostDiscovery,
  ): RendererNativeRequestManager | null => {
    if (disposed) return null;
    try {
      return resolve(discovery ?? read(), hostId);
    } catch {
      return null;
    }
  };
  const retire = (hostId: string): void => {
    const entry = routes.get(hostId);
    routes.delete(hostId);
    entry?.route.policy.dispose();
  };
  const routeFor = (
    hostId: string,
    discovery?: RendererHostDiscovery,
  ): RendererHostRoute | null => {
    const manager = lookup(hostId, discovery);
    const previous = routes.get(hostId);
    if (
      manager &&
      previous?.route.manager === manager &&
      previous.bridge === manager.requestClient &&
      previous.prewarmed === manager.prewarmedThreadManager &&
      previous.route.policy.owns(
        manager,
        manager.requestClient,
        hostId,
        manager.prewarmedThreadManager,
        true,
      )
    ) {
      return previous.route;
    }
    retire(hostId);
    if (!manager) return null;
    const bridge = manager.requestClient;
    const prewarmed = manager.prewarmedThreadManager;
    const policy = createPolicy(
      manager,
      bridge,
      hostId,
      target,
      prewarmed,
      () =>
        lookup(hostId) === manager &&
        manager.requestClient === bridge &&
        manager.prewarmedThreadManager === prewarmed,
    );
    const route = { hostId, manager, policy };
    routes.set(hostId, { route, bridge, prewarmed });
    return route;
  };
  const publish = (route: RendererHostRoute | null): void => {
    const policy = route?.policy;
    if (target.__codexhostDraftPrewarmPolicyV1 === policy) return;
    Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
      configurable: true,
      value: policy,
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
      target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
    }
  };
  const composerHostId = (discovery: RendererHostDiscovery): string | null => {
    // A local hook beside a registry is not proof that a mounting Composer is
    // local. Registry-backed layouts must expose their actual Host identity.
    if (discovery.hostIds.length === 0 && discovery.registries.length > 0) return null;
    const hostIds = new Set(
      discovery.hostIds.length
        ? discovery.hostIds
        : discovery.managers.map(
            (manager) => manager.getHostId?.() ?? manager.requestClient.hostId,
          ),
    );
    const hostId = hostIds.size === 1 ? hostIds.values().next().value : null;
    return typeof hostId === "string" && hostId ? hostId : null;
  };
  const routing: RendererHostRouting = {
    forHost(hostId) {
      return hostId ? routeFor(hostId) : null;
    },
    hostIdForComposer(composer) {
      if (disposed) return null;
      try {
        return composerHostId(read(composer));
      } catch {
        return null;
      }
    },
    forComposer(composer) {
      if (disposed) return null;
      let discovery: RendererHostDiscovery;
      try {
        discovery = read(composer);
      } catch {
        publish(null);
        return null;
      }
      // A switch does not retire a different Host. Only native owner replacement
      // or disconnection retires its hooks and connection-scoped observations.
      if (!composer) {
        for (const [hostId, entry] of routes) {
          const manager = lookup(hostId, discovery);
          if (
            manager !== entry.route.manager ||
            manager.requestClient !== entry.bridge ||
            manager.prewarmedThreadManager !== entry.prewarmed
          )
            retire(hostId);
        }
      }
      const hostId = composerHostId(discovery);
      const route = hostId ? routeFor(hostId, discovery) : null;
      if (!composer) publish(route);
      return route;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hostId of routes.keys()) retire(hostId);
      lastDiscovery = null;
      if (target.__codexhostHostRoutingV1 === routing) {
        delete target.__codexhostHostRoutingV1;
        publish(null);
      }
    },
  };
  Object.defineProperty(target, "__codexhostHostRoutingV1", { configurable: true, value: routing });
  return routing;
}
