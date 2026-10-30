import type {
  findRendererAppScopeStore,
  findRendererHostRpcFamily,
  RendererHostRpc,
  RendererHostRpcDiscovery,
  RendererHostRpcRoot,
  resolveRendererHostRpc,
  rendererHostRpcHostIds,
} from "./renderer-host-rpc-discovery.js";
import type { DraftPrewarmPolicyTarget } from "./renderer-draft-prewarm-runtime.js";
import type { RendererHostRoot } from "./renderer-host-discovery.js";
import type {
  RendererHostRoute,
  RendererHostRouting,
  RendererHostRpcManager,
  RendererHostRoutePolicy,
} from "./renderer-host-routing.js";

interface RendererHostRpcDependencies {
  findStore: typeof findRendererAppScopeStore;
  findFamily: typeof findRendererHostRpcFamily;
  resolve: typeof resolveRendererHostRpc;
  hostIds: typeof rendererHostRpcHostIds;
  /** Host identities named by the given Composer (or every mounted Composer). */
  composerHostIds(composer?: RendererHostRoot): { editorCount: number; hostIds: string[] };
  /** `MessagePort.prototype`: Renderer capnweb calls to the main process leave through it. */
  portPrototype: { postMessage(this: unknown, message: unknown, ...rest: unknown[]): unknown };
}

/**
 * Routing for Desktop builds whose AppServerManagers live in the main process.
 * Desktop Hosts its native request policy there, so codexhost cannot replace it;
 * the Host owns external routing and this route only forwards codexhost requests
 * through the native per-Host RPC client.
 * Self-contained for injection; dependencies are supplied by the Controller.
 */
export function installRendererHostRpcRouting(
  root: RendererHostRpcRoot,
  target: DraftPrewarmPolicyTarget,
  dependencies: RendererHostRpcDependencies,
): RendererHostRouting | null {
  const existing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
  if (existing) return existing;
  let disposed = false;
  let discovery: RendererHostRpcDiscovery | null = null;
  const routes = new Map<string, { route: RendererHostRoute; rpc: RendererHostRpc }>();
  const read = (): RendererHostRpcDiscovery | null => {
    if (disposed) return null;
    if (!discovery) {
      const store = dependencies.findStore(root);
      discovery = store ? dependencies.findFamily(store) : null;
    }
    return discovery;
  };
  if (!read()) return null;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // Draft creation policy. Desktop's Model hook accepts only catalog Models, so a
  // codexhost carrier never reaches the native collaboration mode. The Renderer
  // still issues each creation call; the selected carrier is applied to that call.
  const externalDrafts = new Map<string, string>();
  const selectedModels = new Map<string, string>();
  const prewarmCarrier = (carrier: string): string | null => {
    const prefix = "codexhost/plugin-v1@";
    if (!carrier.startsWith(prefix)) return null;
    try {
      const json = carrier
        .slice(prefix.length)
        .replace(/[a-f0-9]{2}/gu, (byte) => String.fromCharCode(Number.parseInt(byte, 16)));
      const route: unknown = JSON.parse(json);
      if (!isRecord(route)) return null;
      // Schema order keeps the encoding canonical: `prewarm` is its last field.
      const payload = [...JSON.stringify({ ...route, prewarm: true })]
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      return `${prefix}${payload}`;
    } catch {
      return null;
    }
  };
  // The draft's workspace reaches the Host only through its prewarm. Publish it
  // so the Composer can ask for that workspace's live Harness commands.
  const publishDraftWorkspace = (hostId: string, cwd: unknown): void => {
    if (typeof cwd !== "string" || cwd.length === 0) return;
    const drafts = isRecord(target.__codexhostDraftWorkspacesV1)
      ? target.__codexhostDraftWorkspacesV1
      : {};
    if (drafts[hostId] === cwd) return;
    drafts[hostId] = cwd;
    Object.defineProperty(target, "__codexhostDraftWorkspacesV1", {
      configurable: true,
      value: drafts,
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
      target.dispatchEvent(
        new CustomEvent("codexhost:draft-workspace", { detail: { hostId, cwd } }),
      );
    }
  };
  /** Rewrites only the Model of a Renderer-issued capnweb creation call. */
  const routeCreationCall = (message: unknown): unknown => {
    if (!Array.isArray(message) || message.length !== 2 || message[0] !== "push") return message;
    const expression: unknown = message[1];
    if (!Array.isArray(expression) || expression.length !== 4 || expression[0] !== "pipeline")
      return message;
    const [, importId, path, args] = expression as [unknown, unknown, unknown, unknown];
    if (!Array.isArray(path) || path.length !== 1 || !Array.isArray(args)) return message;
    const [input, options] = args as unknown[];
    if (!isRecord(input) || !isRecord(input.collaborationMode)) return message;
    const settings = input.collaborationMode.settings;
    if (!isRecord(settings)) return message;
    let model: string | null = null;
    if (path[0] === "startConversation") {
      const draftId = isRecord(options) ? options.clientThreadId : null;
      model = typeof draftId === "string" ? (externalDrafts.get(draftId) ?? null) : null;
    } else if (path[0] === "prewarmConversation") {
      // Desktop prewarms only local drafts; the pool is keyed by workspace, not Model.
      if (input.ephemeral !== true) publishDraftWorkspace("local", input.cwd);
      const selected = selectedModels.get("local");
      model = selected ? prewarmCarrier(selected) : null;
    }
    if (!model) return message;
    return [
      "push",
      [
        "pipeline",
        importId,
        path,
        [
          {
            ...input,
            collaborationMode: { ...input.collaborationMode, settings: { ...settings, model } },
          },
          ...args.slice(1),
        ],
      ],
    ];
  };
  const port = dependencies.portPrototype;
  const originalPostMessage = port.postMessage;
  const postMessage = function (this: unknown, message: unknown, ...rest: unknown[]): unknown {
    let routed = message;
    try {
      routed = disposed ? message : routeCreationCall(message);
    } catch {
      routed = message;
    }
    return originalPostMessage.call(this, routed, ...rest);
  };
  port.postMessage = postMessage;

  const createRoute = (hostId: string, rpc: RendererHostRpc): RendererHostRoute => {
    let retired = false;
    const isCurrent = (): boolean => !retired && !disposed && routes.get(hostId)?.rpc === rpc;
    const manager: RendererHostRpcManager = Object.freeze({
      kind: "main-process-rpc" as const,
      getHostId: () => hostId,
      sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown> {
        if (!isCurrent())
          return Promise.reject(new Error(`Renderer request manager is retired for ${hostId}`));
        return options === undefined
          ? rpc.sendRequest(method, params)
          : rpc.sendRequest(method, params, options);
      },
      // The main process broadcasts every app-server notification to its windows,
      // including codexhost methods Desktop's own notification table drops.
      addNotificationCallback(
        methods: string | readonly string[],
        listener: (notification: unknown) => void,
      ): () => void {
        const accepted = new Set(typeof methods === "string" ? [methods] : methods);
        const onMessage = (event: Event): void => {
          const { source, data } = event as Event & { source?: unknown; data?: unknown };
          if (source != null && source !== target) return;
          if (
            !isRecord(data) ||
            data.type !== "mcp-notification" ||
            data.hostId !== hostId ||
            typeof data.method !== "string" ||
            !accepted.has(data.method) ||
            !isCurrent()
          )
            return;
          listener({ method: data.method, params: data.params });
        };
        target.addEventListener?.("message", onMessage);
        return () => target.removeEventListener?.("message", onMessage);
      },
    });
    const clear = (): Promise<void> =>
      isCurrent()
        ? Promise.resolve(rpc.clearPrewarmedThreads()).then(() => undefined)
        : Promise.reject(new Error("Renderer request manager is retired"));
    const policy: RendererHostRoutePolicy = Object.freeze({
      state: "ready" as const,
      hostId,
      scopedCreation: true,
      requestTarget: () => {
        if (!isCurrent()) throw new Error("Renderer request manager is retired");
        return manager;
      },
      select(model: string | null, draftId?: string): boolean {
        if (!isCurrent()) throw new Error("Renderer request manager is retired");
        if (model !== null && (typeof model !== "string" || !model.startsWith("codexhost/"))) {
          throw new Error("Draft route Model must be a codexhost transport carrier");
        }
        if (draftId === undefined) {
          if (model === null) externalDrafts.clear();
        } else if (model === null) externalDrafts.delete(draftId);
        else {
          if (!draftId.startsWith("client-new-thread:"))
            throw new Error("External draft route is missing its client Thread identity");
          externalDrafts.set(draftId, model);
        }
        if ((selectedModels.get(hostId) ?? null) === model) return false;
        if (model === null) selectedModels.delete(hostId);
        else selectedModels.set(hostId, model);
        // Main-process prewarms are keyed by workspace, not Model. Calls arrive in
        // order, so this discards any prewarm requested for the previous selection.
        void clear().catch(() => undefined);
        return true;
      },
      clear,
      dispose() {
        retired = true;
        selectedModels.delete(hostId);
      },
    });
    return { hostId, manager, policy };
  };
  const retire = (hostId: string): void => {
    const entry = routes.get(hostId);
    routes.delete(hostId);
    entry?.route.policy.dispose();
  };
  const routeFor = (hostId: string): RendererHostRoute | null => {
    const current = read();
    const rpc = current ? dependencies.resolve(current, hostId) : null;
    const previous = routes.get(hostId);
    if (rpc && previous?.rpc === rpc) return previous.route;
    retire(hostId);
    if (!rpc) return null;
    const route = createRoute(hostId, rpc);
    routes.set(hostId, { route, rpc });
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
  const composerHostId = (composer?: RendererHostRoot): string | null => {
    const hostIds = new Set(dependencies.composerHostIds(composer).hostIds);
    const hostId = hostIds.size === 1 ? hostIds.values().next().value : null;
    return typeof hostId === "string" && hostId ? hostId : null;
  };
  const routing: RendererHostRouting = {
    knownHostIds() {
      const current = read();
      return current ? dependencies.hostIds(current) : [];
    },
    forHost(hostId) {
      return hostId && !disposed ? routeFor(hostId) : null;
    },
    hostIdForComposer(composer) {
      if (disposed) return null;
      try {
        return composerHostId(composer);
      } catch {
        return null;
      }
    },
    forComposer(composer) {
      if (disposed) return null;
      let hostId: string | null;
      try {
        hostId = composerHostId(composer);
      } catch {
        hostId = null;
      }
      const route = hostId ? routeFor(hostId) : null;
      if (!composer) publish(route);
      return route;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hostId of [...routes.keys()]) retire(hostId);
      discovery = null;
      externalDrafts.clear();
      selectedModels.clear();
      if (port.postMessage === postMessage) port.postMessage = originalPostMessage;
      if (target.__codexhostHostRoutingV1 === routing) {
        delete target.__codexhostHostRoutingV1;
        publish(null);
      }
    },
  };
  Object.defineProperty(target, "__codexhostHostRoutingV1", { configurable: true, value: routing });
  return routing;
}
