/**
 * Desktop 26.1027 runs every AppServerManager in the Electron main process. The
 * Renderer holds only one RPC stub per Host, published in the app scope store as
 * a signal-family member `{ status, client: { hostId, rpc } }` keyed by Host ID.
 * Atom definitions are module-private, so the family is identified by the shape
 * of its values. Self-contained: the Controller embeds these functions.
 */

export interface RendererHostRpc {
  sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown>;
  clearPrewarmedThreads(): Promise<unknown>;
}

export interface RendererHostRpcStore {
  readonly familyBindings: Map<unknown, Map<unknown, { value?: unknown }>>;
}

export interface RendererHostRpcDiscovery {
  store: RendererHostRpcStore;
  family: Map<unknown, { value?: unknown }>;
}

export interface RendererHostRpcRoot {
  querySelector?(selector: string): unknown;
  getElementById?(id: string): unknown;
}

/** The root app scope node. Any Desktop `useScope` ref leads to it through `parent`. */
export function findRendererAppScopeStore(root: RendererHostRpcRoot): RendererHostRpcStore | null {
  const MAX_VISITED_FIBERS = 50_000;
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const container = root.getElementById?.("root");
  if (!record(container)) return null;
  const key = Object.getOwnPropertyNames(container).find((name) =>
    name.startsWith("__reactContainer$"),
  );
  const first = key ? container[key] : null;
  if (!record(first)) return null;
  const isScopeHandle = (value: unknown): value is { node: Record<string, unknown> } =>
    record(value) &&
    record(value.node) &&
    "chain" in value &&
    "scope" in value &&
    typeof value.get === "function" &&
    typeof value.set === "function" &&
    typeof value.watch === "function";
  const stack: Record<string, unknown>[] = [first];
  const seen = new Set<unknown>();
  while (stack.length && seen.size < MAX_VISITED_FIBERS) {
    const fiber = stack.pop() as Record<string, unknown>;
    if (seen.has(fiber)) continue;
    seen.add(fiber);
    let hook = fiber.memoizedState;
    for (let index = 0; record(hook) && "next" in hook && index < 150; index += 1) {
      const state = hook.memoizedState;
      const handle = record(state) ? state.current : null;
      if (isScopeHandle(handle)) {
        let node: Record<string, unknown> = handle.node;
        const nodes = new Set<unknown>();
        while (record(node.parent) && !nodes.has(node.parent)) {
          nodes.add(node);
          node = node.parent;
        }
        const bindings = node.familyBindings;
        return record(bindings) &&
          typeof bindings.get === "function" &&
          typeof bindings.entries === "function"
          ? (node as unknown as RendererHostRpcStore)
          : null;
      }
      hook = hook.next;
    }
    if (record(fiber.sibling)) stack.push(fiber.sibling);
    if (record(fiber.child)) stack.push(fiber.child);
  }
  return null;
}

/** Exactly one signal family may publish Host connection values. */
export function findRendererHostRpcFamily(
  store: RendererHostRpcStore,
): RendererHostRpcDiscovery | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const families = new Set<Map<unknown, { value?: unknown }>>();
  for (const [definition, members] of store.familyBindings) {
    if (!record(definition) || definition.kind !== "signal-family") continue;
    if (!record(members) || typeof members.get !== "function") continue;
    for (const [hostId, member] of members) {
      if (typeof hostId !== "string" || !record(member)) continue;
      const signal = member.value;
      if (!record(signal) || typeof signal.get !== "function") continue;
      let value: unknown;
      try {
        value = signal.get();
      } catch {
        continue;
      }
      if (
        record(value) &&
        Object.keys(value).length === 2 &&
        typeof value.status === "string" &&
        record(value.client) &&
        value.client.hostId === hostId &&
        "rpc" in value.client
      ) {
        families.add(members);
        break;
      }
    }
  }
  if (families.size !== 1) return null;
  return { store, family: families.values().next().value as Map<unknown, { value?: unknown }> };
}

/** A ready connection's RPC stub for one Host, or null while unavailable. */
export function resolveRendererHostRpc(
  discovery: RendererHostRpcDiscovery,
  hostId: string,
): RendererHostRpc | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const signal = discovery.family.get(hostId)?.value;
  if (!record(signal) || typeof signal.get !== "function") return null;
  let value: unknown;
  try {
    value = signal.get();
  } catch {
    return null;
  }
  if (
    !record(value) ||
    value.status !== "ready" ||
    !record(value.client) ||
    value.client.hostId !== hostId
  )
    return null;
  // An RPC stub is a callable Proxy; its members cannot be shape-checked.
  const rpc = value.client.rpc;
  return typeof rpc === "function" || record(rpc) ? (rpc as unknown as RendererHostRpc) : null;
}

export function rendererHostRpcHostIds(discovery: RendererHostRpcDiscovery): string[] {
  return [...discovery.family.keys()].filter(
    (hostId): hostId is string => typeof hostId === "string",
  );
}
