import type { RendererAgent } from "./agent-selection-state.js";

export const PI_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const SUPPORTED_RENDERER_ASSET = "app-initial-BbEVL4-_.js";
export const SUPPORTED_DESKTOP_PACKAGE_VERSION = "26.721.4979.0";

export type RendererAdapterState = "installing" | "ready" | "unsupported";

export interface LockedComposerSelection {
  agent: RendererAgent;
  composerId: string;
  phase: "locked";
}

export interface RendererAdapterCandidateShape {
  exportNames: string[];
  ownPrewarmMethod: boolean;
  hasDispatchMessage: boolean;
  hasEnqueueRequest: boolean;
  hasSendRequest: boolean;
  signatureMatch: boolean;
}

export interface RendererAdapterStatus {
  state: RendererAdapterState;
  asset: typeof SUPPORTED_RENDERER_ASSET;
  reason:
    | "installing"
    | "ready"
    | "asset-import-failed"
    | "asset-signature-missing"
    | "bridge-unavailable"
    | "ambiguous-request-client"
    | "invalid-create-params";
  decoratedRequests: number;
  candidateCount: number;
  candidates: RendererAdapterCandidateShape[];
  hook: "bridge" | "client" | "dispatcher" | null;
}

interface ThreadStartParams {
  model: string;
  [key: string]: unknown;
}

type PrewarmThreadStart = (
  params: ThreadStartParams,
  options?: unknown,
) => Promise<unknown> | unknown;

interface PrewarmTarget {
  prewarmThreadStart: PrewarmThreadStart;
}

interface PrewarmDispatcher {
  dispatchMessage(type: string, payload: unknown): unknown;
}

interface ElectronRendererBridge {
  sendMessageFromView(message: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPrewarmMethod(value: unknown): value is PrewarmTarget {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { prewarmThreadStart?: unknown }).prewarmThreadStart === "function"
  );
}

export function findPrewarmTargets(moduleExports: Record<string, unknown>): PrewarmTarget[] {
  const targets = new Set<PrewarmTarget>();
  for (const exported of Object.values(moduleExports)) {
    if (hasPrewarmMethod(exported)) targets.add(exported);
    if (typeof exported === "function" && hasPrewarmMethod(exported.prototype)) {
      targets.add(exported.prototype);
    }
  }
  return [...targets].filter(
    (candidate) =>
      ![...targets].some(
        (other) => other !== candidate && Object.getPrototypeOf(other) === candidate,
      ),
  );
}

function matchesCurrentPrewarmSignature(target: PrewarmTarget): boolean {
  const source = Function.prototype.toString.call(target.prewarmThreadStart);
  return source.includes("enqueueRequest") && source.includes("thread-prewarm-start");
}

export function findActivePrewarmTargets(root: Element, maximumNodes = 20_000): PrewarmTarget[] {
  const queue: Array<{ value: object; depth: number }> = [];
  for (const name of Object.getOwnPropertyNames(root)) {
    if (!name.startsWith("__react")) continue;
    const value = Object.getOwnPropertyDescriptor(root, name)?.value;
    if ((typeof value === "object" || typeof value === "function") && value !== null) {
      queue.push({ value, depth: 0 });
    }
  }

  const visited = new WeakSet<object>();
  const targets = new Set<PrewarmTarget>();
  let visitedCount = 0;
  while (queue.length > 0 && visitedCount < maximumNodes) {
    const current = queue.shift();
    if (!current || visited.has(current.value)) continue;
    visited.add(current.value);
    visitedCount += 1;
    if (hasPrewarmMethod(current.value) && matchesCurrentPrewarmSignature(current.value)) {
      targets.add(current.value);
    }
    if (current.depth >= 14) continue;

    const enqueue = (value: unknown): void => {
      if (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        !(value instanceof Node)
      ) {
        queue.push({ value, depth: current.depth + 1 });
      }
    };
    if (current.value instanceof Map) {
      for (const [key, value] of current.value) {
        enqueue(key);
        enqueue(value);
      }
    } else if (current.value instanceof Set) {
      for (const value of current.value) enqueue(value);
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current.value))) {
      if ("value" in descriptor) enqueue(descriptor.value);
    }
    enqueue(Object.getPrototypeOf(current.value));
  }
  return [...targets];
}

export function describePrewarmTargets(
  moduleExports: Record<string, unknown>,
  targets: PrewarmTarget[],
): RendererAdapterCandidateShape[] {
  return targets.map((target) => ({
    exportNames: Object.entries(moduleExports)
      .filter(
        ([, exported]) =>
          exported === target || (typeof exported === "function" && exported.prototype === target),
      )
      .map(([name]) => name)
      .sort(),
    ownPrewarmMethod: Object.prototype.hasOwnProperty.call(target, "prewarmThreadStart"),
    hasDispatchMessage:
      typeof (target as { dispatchMessage?: unknown }).dispatchMessage === "function",
    hasEnqueueRequest:
      typeof (target as { enqueueRequest?: unknown }).enqueueRequest === "function",
    hasSendRequest: typeof (target as { sendRequest?: unknown }).sendRequest === "function",
    signatureMatch: matchesCurrentPrewarmSignature(target),
  }));
}

export function decorateThreadStartParams(
  params: unknown,
  selection: LockedComposerSelection | null,
): ThreadStartParams {
  if (!isRecord(params) || typeof params.model !== "string") {
    throw new Error("thread/start params must contain a text Model");
  }
  if (selection?.agent !== "pi") return params as ThreadStartParams;
  return { ...params, model: PI_TRANSPORT_MODEL_ID } as ThreadStartParams;
}

export function wrapElectronRendererBridge(
  bridge: ElectronRendererBridge,
  getSelection: () => LockedComposerSelection | null,
  onDecorated: () => void,
): () => void {
  const original = bridge.sendMessageFromView;
  const wrapped = function (this: unknown, message: unknown): unknown {
    const selection = getSelection();
    if (
      selection?.agent !== "pi" ||
      !isRecord(message) ||
      !isRecord(message.request) ||
      message.request.method !== "thread/start"
    ) {
      return original.call(this, message);
    }
    const request = message.request;
    const params = decorateThreadStartParams(request.params, selection);
    const decoratedMessage = { ...message, request: { ...request, params } };
    onDecorated();
    return original.call(this, decoratedMessage);
  };
  bridge.sendMessageFromView = wrapped;
  return () => {
    if (bridge.sendMessageFromView === wrapped) bridge.sendMessageFromView = original;
  };
}

export function wrapPrewarmDispatcher(
  dispatcher: PrewarmDispatcher,
  getSelection: () => LockedComposerSelection | null,
  onDecorated: () => void,
): () => void {
  const original = dispatcher.dispatchMessage;
  const wrapped = function (this: unknown, type: string, payload: unknown): unknown {
    const selection = getSelection();
    if (selection?.agent !== "pi") return original.call(this, type, payload);
    if (!isRecord(payload) || !isRecord(payload.request)) {
      if (type === "thread-prewarm-start") {
        throw new Error("thread-prewarm-start payload must contain a Request");
      }
      return original.call(this, type, payload);
    }
    const request = payload.request;
    if (request.method !== "thread/start") return original.call(this, type, payload);
    const params = decorateThreadStartParams(request.params, selection);
    const decoratedPayload = { ...payload, request: { ...request, params } };
    onDecorated();
    return original.call(this, type, decoratedPayload);
  };
  dispatcher.dispatchMessage = wrapped;
  return () => {
    if (dispatcher.dispatchMessage === wrapped) dispatcher.dispatchMessage = original;
  };
}

export function wrapPrewarmTarget(
  target: PrewarmTarget,
  getSelection: () => LockedComposerSelection | null,
  onDecorated: () => void,
): () => void {
  const original = target.prewarmThreadStart;
  const wrapped: PrewarmThreadStart = function (this: unknown, params, options) {
    const selection = getSelection();
    const decorated = decorateThreadStartParams(params, selection);
    if (decorated !== params) onDecorated();
    return original.call(this, decorated, options);
  };
  target.prewarmThreadStart = wrapped;
  return () => {
    if (target.prewarmThreadStart === wrapped) target.prewarmThreadStart = original;
  };
}

export async function installCurrentRendererAdapter(
  getSelection: () => LockedComposerSelection | null,
): Promise<{ status: RendererAdapterStatus; dispose(): void }> {
  let decoratedRequests = 0;
  const status = (
    state: RendererAdapterState,
    reason: RendererAdapterStatus["reason"],
    candidates: RendererAdapterCandidateShape[],
    hook: RendererAdapterStatus["hook"],
  ): RendererAdapterStatus => ({
    state,
    asset: SUPPORTED_RENDERER_ASSET,
    reason,
    decoratedRequests,
    candidateCount: candidates.length,
    candidates,
    hook,
  });

  const assetPresent =
    [...document.querySelectorAll("script[src], link[href]")].some((element) =>
      [element.getAttribute("src"), element.getAttribute("href")].some((value) =>
        value?.includes(SUPPORTED_RENDERER_ASSET),
      ),
    ) ||
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes(SUPPORTED_RENDERER_ASSET));
  if (!assetPresent) {
    return {
      status: status("unsupported", "asset-signature-missing", [], null),
      dispose() {},
    };
  }

  const rendererRoot = document.getElementById("root");
  const activeTargets = rendererRoot ? findActivePrewarmTargets(rendererRoot) : [];
  const activeCandidates = describePrewarmTargets({}, activeTargets);
  const activeTarget = activeTargets.length === 1 ? activeTargets[0] : null;
  if (activeTarget) {
    const dispose = wrapPrewarmTarget(activeTarget, getSelection, () => {
      decoratedRequests += 1;
    });
    return {
      get status() {
        return status("ready", "ready", activeCandidates, "client");
      },
      dispose,
    };
  }

  const bridge = (window as unknown as { electronBridge?: unknown }).electronBridge;
  if (
    (typeof bridge !== "object" && typeof bridge !== "function") ||
    bridge === null ||
    typeof (bridge as { sendMessageFromView?: unknown }).sendMessageFromView !== "function"
  ) {
    return {
      status: status("unsupported", "bridge-unavailable", activeCandidates, null),
      dispose() {},
    };
  }

  try {
    const dispose = wrapElectronRendererBridge(
      bridge as ElectronRendererBridge,
      getSelection,
      () => {
        decoratedRequests += 1;
      },
    );
    return {
      get status() {
        return status("ready", "ready", activeCandidates, "bridge");
      },
      dispose,
    };
  } catch {
    return {
      status: status("unsupported", "bridge-unavailable", activeCandidates, null),
      dispose() {},
    };
  }
}
