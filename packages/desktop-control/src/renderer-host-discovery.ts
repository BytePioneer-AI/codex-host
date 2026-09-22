import { committedReactAncestors } from "./renderer-react-ownership.js";
import type {
  RendererHostRequestBridge,
  RendererHostRequestManager,
  RendererPrewarmedThreadManager,
} from "./renderer-draft-prewarm-runtime.js";

export interface RendererNativeRequestManager extends RendererHostRequestManager {
  sendRequest(method: string, params: unknown, options?: unknown): unknown;
  getHostId?(): unknown;
  requestClient: RendererHostRequestBridge & { hostId?: unknown };
  prewarmedThreadManager: RendererPrewarmedThreadManager;
  addNotificationCallback?: (
    method: string | readonly string[],
    listener: (notification: unknown) => void,
  ) => () => void;
}

export interface RendererHostRegistry {
  getForHostId(hostId: string): unknown;
}

export interface RendererHostRoot {
  querySelectorAll(selector: string): Iterable<RendererHostRoot>;
  parentElement?: RendererHostRoot | null;
  matches?(selector: string): boolean;
}

export interface RendererHostDiscovery {
  editorCount: number;
  hostIds: string[];
  managers: RendererNativeRequestManager[];
  registries: RendererHostRegistry[];
}

// Self-contained: also embedded in the Controller's Renderer installation expression.
export function requestManagerFromHookState(
  value: unknown,
  hostId?: string,
): RendererNativeRequestManager | null {
  const record = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null;
  const manager = (candidate: unknown): RendererNativeRequestManager | null => {
    if (
      !record(candidate) ||
      !record(candidate.requestClient) ||
      !record(candidate.prewarmedThreadManager)
    )
      return null;
    const bridge = candidate.requestClient;
    return typeof candidate.sendRequest === "function" &&
      typeof bridge.sendRequest === "function" &&
      typeof bridge.prewarmThreadStart === "function" &&
      typeof bridge.enqueueRequest === "function" &&
      typeof candidate.prewarmedThreadManager.discardAllPrewarmedThreads === "function"
      ? (candidate as unknown as RendererNativeRequestManager)
      : null;
  };
  if (!record(value)) return null;
  const direct = manager(value) ?? manager(value.manager);
  if (direct) return direct;
  if (
    !hostId ||
    typeof value.addManager !== "function" ||
    typeof value.getForHostId !== "function" ||
    typeof value.waitForManagerForHostId !== "function"
  )
    return null;
  return manager(value.getForHostId(hostId));
}

/** Discover native owners, not a selected draft policy. Registry lookups are done
 * per requested Host, including Hosts that have no currently visible Composer. */
export function discoverRendererHosts(
  root: RendererHostRoot,
  ancestors: typeof committedReactAncestors = committedReactAncestors,
  managerFrom: typeof requestManagerFromHookState = requestManagerFromHookState,
): RendererHostDiscovery {
  const editors = [
    ...root.querySelectorAll('[data-codex-composer], [contenteditable="true"][role="textbox"]'),
  ];
  const hostIds = new Set<string>();
  const managers = new Set<RendererNativeRequestManager>();
  const registries = new Set<RendererHostRegistry>();
  const fibers = new Set<ReturnType<typeof committedReactAncestors>[number]>();
  for (const editor of editors) {
    let element: RendererHostRoot | null = editor;
    let fiber: unknown;
    while (element && !fiber) {
      const key = Object.getOwnPropertyNames(element).find((name) =>
        name.startsWith("__reactFiber$"),
      );
      if (key) fiber = Object.getOwnPropertyDescriptor(element, key)?.value;
      element = element.parentElement ?? null;
    }
    for (const current of ancestors(fiber)) {
      fibers.add(current);
      const props = current.memoizedProps as Record<string, unknown> | null;
      for (const key of ["executionTargetHostId", "permissionsHostId"]) {
        const hostId = props?.[key];
        if (typeof hostId === "string" && hostId) hostIds.add(hostId);
      }
    }
  }
  for (const fiber of fibers) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let index = 0; hook && index < 120; index += 1) {
      const value = hook.memoizedState;
      const manager = managerFrom(value);
      if (manager) managers.add(manager);
      if (
        value &&
        typeof value === "object" &&
        "addManager" in value &&
        typeof value.addManager === "function" &&
        "getForHostId" in value &&
        typeof value.getForHostId === "function" &&
        "waitForManagerForHostId" in value &&
        typeof value.waitForManagerForHostId === "function"
      ) {
        registries.add(value as RendererHostRegistry);
      }
      hook = hook.next && typeof hook.next === "object" ? hook.next : null;
    }
  }
  return {
    editorCount: editors.length,
    hostIds: [...hostIds],
    managers: [...managers],
    registries: [...registries],
  };
}

/** A present registry is authoritative. A disconnected/replaced registry entry
 * must never fall back to an old manager still present in another hook. */
export function resolveRendererHostManager(
  discovery: RendererHostDiscovery,
  hostId: string,
  managerFrom: typeof requestManagerFromHookState = requestManagerFromHookState,
): RendererNativeRequestManager | null {
  if (!hostId) return null;
  const candidates = discovery.registries.length
    ? discovery.registries.map((registry) => managerFrom(registry.getForHostId(hostId)))
    : discovery.managers;
  const matching = new Set(
    candidates.filter(
      (manager) =>
        manager &&
        (manager.getHostId?.() ?? manager.requestClient.hostId) === hostId &&
        (manager.requestClient.hostId === undefined || manager.requestClient.hostId === hostId),
    ),
  );
  return matching.size === 1 ? (matching.values().next().value ?? null) : null;
}
