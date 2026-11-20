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
import type { RendererHostDiscovery, RendererHostRoot } from "./renderer-host-discovery.js";
import type { RendererConnectionGeneration } from "./renderer-connection-generation.js";
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
  /** Current owners of the given Composer (or every mounted Composer). */
  discoverComposer(composer?: RendererHostRoot): RendererHostDiscovery;
  /** `MessagePort.prototype`: Renderer capnweb calls to the main process leave through it. */
  portPrototype: { postMessage(this: unknown, message: unknown, ...rest: unknown[]): unknown };
  /** Installs a native router after Composer discovery has found a native owner. */
  installNativeRouting(): RendererHostRouting;
  readConnection?(hostId: string): RendererConnectionGeneration | null | undefined;
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
  let nativeRouting: RendererHostRouting | null = null;
  let discovery: RendererHostRpcDiscovery | null = null;
  const routes = new Map<
    string,
    {
      route: RendererHostRoute;
      rpc: RendererHostRpc;
      connection: RendererConnectionGeneration | undefined;
    }
  >();
  const read = (): RendererHostRpcDiscovery | null => {
    if (disposed) return null;
    try {
      const store = dependencies.findStore(root);
      // Scanning reads signals, and reading mounts them: native atoms send requests
      // on mount. Keep a discovered family until Desktop removes it from the store.
      const bound =
        store && discovery?.store === store
          ? [...store.familyBindings.values()].includes(discovery.family)
          : false;
      if (!bound) discovery = store ? dependencies.findFamily(store) : null;
    } catch {
      discovery = null;
    }
    return discovery;
  };
  if (!read()) return null;

  const discoverComposer = (composer?: RendererHostRoot): RendererHostDiscovery => {
    const owners = dependencies.discoverComposer(composer);
    // Composer/Host reconciliation already reads these owners. Host lookups do
    // not search the document for a native manager that may not exist there.
    if (!nativeRouting && (owners.managers.length || owners.registries.length)) {
      try {
        nativeRouting = dependencies.installNativeRouting();
      } catch {
        /* A failing optional native owner must not disable the ready RPC peer. */
      }
    }
    return owners;
  };
  const connectionFor = (hostId: string): RendererConnectionGeneration | null | undefined => {
    if (!hostId.startsWith("remote-control:")) return undefined;
    try {
      return dependencies.readConnection?.(hostId);
    } catch {
      return null;
    }
  };
  const sameConnection = (
    previous: RendererConnectionGeneration | undefined,
    current: RendererConnectionGeneration | null | undefined,
  ): boolean =>
    previous === undefined
      ? current === undefined
      : current?.owner === previous.owner && current.revision === previous.revision;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // Draft creation policy. Desktop's Model hook accepts only catalog Models, so a
  // codexhost carrier never reaches the native collaboration mode. The Renderer
  // still issues each creation call; the selected carrier is applied to that call.
  const externalDrafts = new Map<string, { model: string; owner: RendererHostRoutePolicy }>();
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
    // A creation can omit its native Model; a registered external draft still needs its carrier.
    const nativeModel = typeof settings.model === "string" ? settings.model : null;
    let model: string | null = null;
    if (path[0] === "startConversation") {
      const draftId = isRecord(options) ? options.clientThreadId : null;
      model = typeof draftId === "string" ? (externalDrafts.get(draftId)?.model ?? null) : null;
    } else if (path[0] === "prewarmConversation") {
      // Desktop prewarms only local drafts; the pool is keyed by workspace, not Model.
      if (input.ephemeral !== true) publishDraftWorkspace("local", input.cwd);
      const selected = selectedModels.get("local") ?? null;
      // A prewarm that names an external carrier keeps it; Host still needs the prewarm marker
      // to treat it as a discardable prewarm instead of a new Thread.
      const carrier = nativeModel?.startsWith("codexhost/") ? nativeModel : selected;
      model = carrier ? prewarmCarrier(carrier) : null;
    }
    if (!model) return message;
    // A creation that names a different external carrier keeps it.
    if (
      path[0] === "startConversation" &&
      nativeModel?.startsWith("codexhost/") &&
      nativeModel !== model
    )
      return message;
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
      routed = disposed || routes.size === 0 ? message : routeCreationCall(message);
    } catch {
      routed = message;
    }
    return originalPostMessage.call(this, routed, ...rest);
  };
  port.postMessage = postMessage;

  const createRoute = (
    hostId: string,
    rpc: RendererHostRpc,
    connection: RendererConnectionGeneration | undefined,
  ): RendererHostRoute => {
    let retired = false;
    const isCurrent = (): boolean => {
      if (
        retired ||
        disposed ||
        routes.get(hostId)?.rpc !== rpc ||
        !sameConnection(connection, connectionFor(hostId))
      )
        return false;
      try {
        const current = read();
        return !!current && dependencies.resolve(current, hostId) === rpc;
      } catch {
        return false;
      }
    };
    const manager: RendererHostRpcManager = Object.freeze({
      kind: "main-process-rpc" as const,
      getHostId: () => hostId,
      ...(typeof rpc.getConversation === "function"
        ? {
            getConversation: async (threadId: string) => {
              if (!isCurrent()) throw new Error("Remote manager retired");
              return rpc.getConversation?.(threadId);
            },
          }
        : {}),
      ...(typeof rpc.replyWithCommandExecutionApprovalDecision === "function"
        ? {
            replyWithCommandExecutionApprovalDecision: async (
              threadId: string,
              requestId: string | number,
              decision: string,
            ) => {
              if (!isCurrent()) throw new Error("Remote manager retired");
              return rpc.replyWithCommandExecutionApprovalDecision?.(threadId, requestId, decision);
            },
          }
        : {}),
      ...(typeof rpc.replyWithFileChangeApprovalDecision === "function"
        ? {
            replyWithFileChangeApprovalDecision: async (
              threadId: string,
              requestId: string | number,
              decision: string,
            ) => {
              if (!isCurrent()) throw new Error("Remote manager retired");
              return rpc.replyWithFileChangeApprovalDecision?.(threadId, requestId, decision);
            },
          }
        : {}),
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
    const clearDrafts = (): void => {
      for (const [draftId, draft] of externalDrafts) {
        if (draft.owner === policy) externalDrafts.delete(draftId);
      }
    };
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
          if (model === null) clearDrafts();
        } else if (model === null) {
          if (externalDrafts.get(draftId)?.owner === policy) externalDrafts.delete(draftId);
        } else {
          if (!draftId.startsWith("client-new-thread:"))
            throw new Error("External draft route is missing its client Thread identity");
          externalDrafts.set(draftId, { model, owner: policy });
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
        if (retired) return;
        retired = true;
        clearDrafts();
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
  const routeFor = (
    hostId: string,
    nativeRoute?: RendererHostRoute | null,
  ): RendererHostRoute | null => {
    if (disposed || hostId === "durable") return null;
    const connection = connectionFor(hostId);
    const preferred = nativeRoute === undefined ? nativeRouting?.forHost(hostId) : nativeRoute;
    if (connection === null || preferred) {
      retire(hostId);
      return connection === null ? null : (preferred ?? null);
    }
    const current = read();
    const rpc = current ? dependencies.resolve(current, hostId) : null;
    const previous = routes.get(hostId);
    if (rpc && previous?.rpc === rpc && sameConnection(previous.connection, connection))
      return previous.route;
    retire(hostId);
    if (!rpc) return null;
    const route = createRoute(hostId, rpc, connection);
    routes.set(hostId, { route, rpc, connection });
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
  const composerHostId = (
    owners: RendererHostDiscovery | null,
    composer?: RendererHostRoot,
  ): string | null => {
    const nativeHostId = nativeRouting?.hostIdForComposer(composer);
    if (nativeHostId) return nativeHostId;
    const hostIds = new Set((owners ?? discoverComposer(composer)).hostIds);
    const hostId = hostIds.size === 1 ? hostIds.values().next().value : null;
    return typeof hostId === "string" && hostId ? hostId : null;
  };
  const routing: RendererHostRouting = {
    knownHostIds() {
      if (disposed) return [];
      try {
        if (!nativeRouting) discoverComposer();
      } catch {
        /* Keep RPC Hosts enumerable while Composer ownership is unavailable. */
      }
      const current = read();
      return [
        ...new Set([
          ...(current
            ? dependencies
                .hostIds(current)
                .filter(
                  (hostId) =>
                    hostId !== "durable" &&
                    connectionFor(hostId) !== null &&
                    dependencies.resolve(current, hostId) !== null,
                )
            : []),
          ...(nativeRouting?.knownHostIds?.() ?? []).filter(
            (hostId) => hostId !== "durable" && connectionFor(hostId) !== null,
          ),
        ]),
      ];
    },
    forHost(hostId) {
      return hostId && !disposed ? routeFor(hostId) : null;
    },
    hostIdForComposer(composer) {
      if (disposed) return null;
      try {
        return composerHostId(nativeRouting ? null : discoverComposer(composer), composer);
      } catch {
        return null;
      }
    },
    forComposer(composer) {
      if (disposed) return null;
      let hostId: string | null;
      let preferred: RendererHostRoute | null = null;
      try {
        const owners = nativeRouting ? null : discoverComposer(composer);
        // Native reconciliation also retires hooks for other disconnected Hosts.
        // Its private router cannot publish over this shared routing owner.
        preferred = nativeRouting?.forComposer(composer) ?? null;
        hostId = preferred?.hostId ?? composerHostId(owners, composer);
      } catch {
        hostId = null;
      }
      const route = hostId ? routeFor(hostId, preferred) : null;
      if (!composer) publish(route);
      return route;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      nativeRouting?.dispose();
      nativeRouting = null;
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
