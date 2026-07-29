import {
  harnessModelRefSchema,
  hostThreadIdSchema,
  type HarnessModelRef,
  type HostThreadId,
  type PiHarnessInspectParams,
  type ThreadInspectionParams,
  type ThreadModelSelectParams,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { createRendererModelClient, type RendererModelClient } from "./renderer-model-client.js";

export const PI_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_TRANSPORT_MODEL_PREFIX = `${PI_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";

export type RendererAdapterState = "installing" | "ready" | "unsupported";

export interface LockedComposerSelection {
  agent: RendererAgent;
  composerId: string;
  phase: "locked";
  model?: HarnessModelRef;
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
  reason:
    | "installing"
    | "ready"
    | "asset-import-failed"
    | "bridge-unavailable"
    | "title-policy-unavailable"
    | "draft-prewarm-policy-unavailable"
    | "draft-prewarm-clear-failed"
    | "model-controller-unavailable"
    | "ambiguous-request-client"
    | "invalid-create-params";
  decoratedRequests: number;
  modelUpdates: number;
  candidateCount: number;
  candidates: RendererAdapterCandidateShape[];
  hook: "bridge" | "client" | "dispatcher" | "model-state" | null;
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
  prewarmThreadStart?: PrewarmThreadStart;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: PrewarmTarget;
}

interface PrewarmDispatcher {
  dispatchMessage(type: string, payload: unknown): unknown;
}

interface ElectronRendererBridge {
  sendMessageFromView(message: unknown): unknown;
}

export interface ModelPowerSelection {
  model: unknown;
  reasoningEffort: unknown;
  [key: string]: unknown;
}

export interface ModelStateController {
  apply(selection: ModelPowerSelection | null): void;
  current: ModelPowerSelection | null;
  reasoningEffort: unknown;
}

export interface ModelAtomState {
  atom: object;
  get(): ModelPowerSelection | null;
  set(selection: ModelPowerSelection | null): unknown;
}

export interface ModelAtomPair {
  optimistic: ModelAtomState;
  committed: ModelAtomState;
  target: readonly unknown[];
}

export interface RendererDraftPrewarmPolicy {
  state: "ready";
  clear(): Promise<void>;
}

declare global {
  interface Window {
    __codexhostMainProcessTitlePolicyV1?: { state: "ready" };
    __codexhostDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
  }
}

function transportModelIdForAgent(agent: RendererAgent): string | null {
  if (agent === "pi") return PI_TRANSPORT_MODEL_ID;
  if (agent === "claude-code") return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  return null;
}

function isTransportModelId(model: unknown): boolean {
  return isPiTransportModelId(model) || model === CLAUDE_CODE_TRANSPORT_MODEL_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function piTransportModelId(model?: HarnessModelRef): string {
  return model
    ? `${PI_TRANSPORT_MODEL_PREFIX}${harnessModelRefSchema.parse(model).id}`
    : PI_TRANSPORT_MODEL_ID;
}

export function isPiTransportModelId(value: unknown): value is string {
  if (value === PI_TRANSPORT_MODEL_ID) return true;
  if (typeof value !== "string" || !value.startsWith(PI_TRANSPORT_MODEL_PREFIX)) return false;
  return harnessModelRefSchema.safeParse({
    id: value.slice(PI_TRANSPORT_MODEL_PREFIX.length),
  }).success;
}

export function threadIdFromComposerModelTarget(
  target: readonly unknown[] | null,
): HostThreadId | null {
  if (
    target?.[0] !== "conversation" ||
    typeof target[1] !== "string" ||
    target[1].trim().length === 0
  ) {
    return null;
  }
  return hostThreadIdSchema.parse(target[1]);
}

function hasPrewarmMethod(value: unknown): value is PrewarmTarget {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { prewarmThreadStart?: unknown }).prewarmThreadStart === "function"
  );
}

function isActiveRequestManager(value: unknown): value is PrewarmTarget {
  if (!isRecord(value) || typeof value.sendRequest !== "function") return false;
  const source = Function.prototype.toString.call(value.sendRequest);
  return source.includes("send-cli-request-for-host") && hasPrewarmMethod(value.requestClient);
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
  const prewarm = target.prewarmThreadStart ?? target.requestClient?.prewarmThreadStart;
  if (!prewarm) return false;
  const source = Function.prototype.toString.call(prewarm);
  return (
    (source.includes("enqueueRequest") && source.includes("thread-prewarm-start")) ||
    source.includes("prewarm-thread-start-for-host")
  );
}

export function findActivePrewarmTargets(root: ParentNode): PrewarmTarget[] {
  const editor = root.querySelector<HTMLElement>(
    '[data-codex-composer], [contenteditable="true"][role="textbox"]',
  );
  if (!editor) return [];

  let fiberElement: Element | undefined = [editor, ...editor.querySelectorAll("*")].find(
    (element) =>
      Object.getOwnPropertyNames(element).some((name) => name.startsWith("__reactFiber$")),
  );
  for (let ancestor = editor.parentElement; !fiberElement && ancestor;) {
    if (Object.getOwnPropertyNames(ancestor).some((name) => name.startsWith("__reactFiber$"))) {
      fiberElement = ancestor;
      break;
    }
    ancestor = ancestor.parentElement;
  }
  const fiberName = fiberElement
    ? Object.getOwnPropertyNames(fiberElement).find((name) => name.startsWith("__reactFiber$"))
    : null;
  const firstFiber =
    fiberElement && fiberName
      ? Object.getOwnPropertyDescriptor(fiberElement, fiberName)?.value
      : null;
  if ((typeof firstFiber !== "object" && typeof firstFiber !== "function") || !firstFiber) {
    return [];
  }

  const targets = new Set<PrewarmTarget>();
  let fiber = firstFiber as { return?: unknown; memoizedState?: unknown };
  for (let depth = 0; depth < 200; depth += 1) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let hookIndex = 0; hook && hookIndex < 100; hookIndex += 1) {
      const hookState = hook.memoizedState;
      if (isRecord(hookState)) {
        const requestClient = hookState.requestClient;
        if (isActiveRequestManager(hookState) && matchesCurrentPrewarmSignature(hookState)) {
          targets.add(hookState);
        } else if (
          hasPrewarmMethod(requestClient) &&
          matchesCurrentPrewarmSignature(requestClient)
        ) {
          targets.add(requestClient);
        }
      }
      hook =
        typeof hook.next === "object" && hook.next !== null
          ? (hook.next as { memoizedState?: unknown; next?: unknown })
          : null;
    }
    const parent = fiber.return;
    if ((typeof parent !== "object" && typeof parent !== "function") || parent === null) break;
    fiber = parent as typeof fiber;
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
    ownPrewarmMethod:
      Object.prototype.hasOwnProperty.call(target, "prewarmThreadStart") ||
      Object.prototype.hasOwnProperty.call(target.requestClient ?? {}, "prewarmThreadStart"),
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
  if (!selection) return params as ThreadStartParams;
  const transportModelId =
    selection.agent === "pi"
      ? piTransportModelId(selection.model)
      : transportModelIdForAgent(selection.agent);
  return transportModelId
    ? ({ ...params, model: transportModelId } as ThreadStartParams)
    : (params as ThreadStartParams);
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
      selection == null ||
      transportModelIdForAgent(selection.agent) == null ||
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
    if (!selection || transportModelIdForAgent(selection.agent) == null) {
      return original.call(this, type, payload);
    }
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
  const prewarmTarget = target.prewarmThreadStart ? target : target.requestClient;
  const originalPrewarm = prewarmTarget?.prewarmThreadStart;
  const wrappedPrewarm: PrewarmThreadStart | null = originalPrewarm
    ? function (this: unknown, params, options) {
        const selection = getSelection();
        const decorated = decorateThreadStartParams(params, selection);
        if (decorated !== params) onDecorated();
        return originalPrewarm.call(this, decorated, options);
      }
    : null;
  if (prewarmTarget && wrappedPrewarm) prewarmTarget.prewarmThreadStart = wrappedPrewarm;

  const originalSendRequest = target.sendRequest;
  const wrappedSendRequest = originalSendRequest
    ? function (this: unknown, method: string, params: unknown, options?: unknown): unknown {
        if (method !== "thread/start") {
          return originalSendRequest.call(this, method, params, options);
        }
        const selection = getSelection();
        const decorated = decorateThreadStartParams(params, selection);
        if (decorated !== params) onDecorated();
        return originalSendRequest.call(this, method, decorated, options);
      }
    : null;
  if (wrappedSendRequest) target.sendRequest = wrappedSendRequest;

  return () => {
    if (
      prewarmTarget &&
      originalPrewarm &&
      wrappedPrewarm &&
      prewarmTarget.prewarmThreadStart === wrappedPrewarm
    ) {
      prewarmTarget.prewarmThreadStart = originalPrewarm;
    }
    if (originalSendRequest && wrappedSendRequest && target.sendRequest === wrappedSendRequest) {
      target.sendRequest = originalSendRequest;
    }
  };
}

function isModelAtomState(value: unknown): value is ModelAtomState {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return (
    keys === "atom,get,set,store,subscribe" &&
    isRecord(value.atom) &&
    typeof value.get === "function" &&
    typeof value.set === "function"
  );
}

function isModelSelection(value: unknown): value is ModelPowerSelection | null {
  return (
    value === null ||
    (isRecord(value) &&
      Object.keys(value).sort().join(",") === "model,reasoningEffort" &&
      "model" in value &&
      "reasoningEffort" in value)
  );
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function selectOptimisticModelAtom(pairs: readonly ModelAtomPair[]): ModelAtomState | null {
  const first = pairs[0];
  if (!first || first.optimistic.atom === first.committed.atom) return null;
  if (
    !pairs.every(
      (pair) =>
        pair.optimistic.atom === first.optimistic.atom &&
        pair.committed.atom === first.committed.atom &&
        sameTarget(pair.target, first.target),
    )
  ) {
    return null;
  }
  return first.optimistic;
}

function findComposerFiber(composer?: Element): { return?: unknown; updateQueue?: unknown } | null {
  const selector = '[data-codex-composer], [contenteditable="true"][role="textbox"]';
  const editor =
    composer?.matches(selector) === true
      ? composer
      : (composer ?? document).querySelector<HTMLElement>(selector);
  let fiberElement: Element | null = editor;
  let fiberName: string | undefined;
  for (let depth = 0; fiberElement && depth < 12; depth += 1) {
    fiberName = Object.getOwnPropertyNames(fiberElement).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    if (fiberName) break;
    fiberElement = fiberElement.parentElement;
  }
  return fiberElement && fiberName
    ? (Object.getOwnPropertyDescriptor(fiberElement, fiberName)?.value as {
        return?: unknown;
        updateQueue?: unknown;
      } | null)
    : null;
}

function findReasoningEffort(): { found: boolean; value: unknown } {
  const matches: Array<{ callback: unknown; value: unknown }> = [];
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-codex-composer-root] button[aria-haspopup="menu"]',
  )) {
    const fiberName = Object.getOwnPropertyNames(button).find((name) =>
      name.startsWith("__reactFiber$"),
    );
    let fiber = fiberName
      ? (Object.getOwnPropertyDescriptor(button, fiberName)?.value as {
          return?: unknown;
          memoizedProps?: unknown;
        } | null)
      : null;
    for (let depth = 0; fiber && depth < 60; depth += 1) {
      const props = fiber.memoizedProps;
      if (
        isRecord(props) &&
        typeof props.onSelectModel === "function" &&
        typeof props.onSelectReasoningEffort === "function" &&
        "reasoningEffort" in props &&
        isRecord(props.fallbackPowerSelection)
      ) {
        matches.push({ callback: props.onSelectModel, value: props.reasoningEffort });
      }
      const parent = fiber.return;
      fiber =
        (typeof parent === "object" || typeof parent === "function") && parent !== null
          ? (parent as typeof fiber)
          : null;
    }
  }
  const uniqueCallbacks = new Set(matches.map((match) => match.callback));
  const first = matches[0];
  return {
    found:
      first !== undefined &&
      uniqueCallbacks.size === 1 &&
      matches.every((match) => match.value === first.value),
    value: first?.value,
  };
}

function findModelAtomPairs(composer?: Element): ModelAtomPair[] {
  const pairs: ModelAtomPair[] = [];
  let fiber = findComposerFiber(composer);
  for (let depth = 0; fiber && depth < 120; depth += 1) {
    const updateQueue = fiber.updateQueue;
    const memoCache = isRecord(updateQueue) ? updateQueue.memoCache : null;
    const data = isRecord(memoCache) && Array.isArray(memoCache.data) ? memoCache.data : [];
    for (let index = 0; index + 3 < data.length; index += 1) {
      const first = data[index];
      const firstResolved = data[index + 1];
      const second = data[index + 2];
      const secondResolved = data[index + 3];
      if (
        !Array.isArray(first) ||
        first.length !== 3 ||
        !Array.isArray(firstResolved) ||
        firstResolved.length !== 4 ||
        !Array.isArray(second) ||
        second.length !== 3 ||
        !Array.isArray(secondResolved) ||
        secondResolved.length !== 4
      ) {
        continue;
      }
      const target = firstResolved[2];
      const secondTarget = secondResolved[2];
      const optimistic = firstResolved[3];
      const committed = secondResolved[3];
      if (
        !Array.isArray(target) ||
        !Array.isArray(secondTarget) ||
        target !== secondTarget ||
        (target[0] !== "default" && target[0] !== "conversation") ||
        !isModelAtomState(optimistic) ||
        !isModelAtomState(committed)
      ) {
        continue;
      }
      let optimisticValue: unknown;
      let committedValue: unknown;
      try {
        optimisticValue = optimistic.get();
        committedValue = committed.get();
      } catch {
        continue;
      }
      if (!isModelSelection(optimisticValue) || !isModelSelection(committedValue)) continue;
      pairs.push({ optimistic, committed, target });
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return pairs;
}

export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const pairs = findModelAtomPairs(composer);
  if (!selectOptimisticModelAtom(pairs)) return null;
  return pairs[0]?.target ?? null;
}

function findModelStateController(): ModelStateController | null {
  const pairs = findModelAtomPairs();
  const optimistic = selectOptimisticModelAtom(pairs);
  const reasoningEffort = findReasoningEffort();
  if (!optimistic || !reasoningEffort.found) return null;
  const current = optimistic.get();
  if (!isModelSelection(current)) return null;
  return {
    apply(selection) {
      optimistic.set(selection);
    },
    current,
    reasoningEffort: reasoningEffort.value,
  };
}

export function isMainProcessTitlePolicyReady(value: unknown): boolean {
  return isRecord(value) && value.state === "ready";
}

export function isDraftPrewarmPolicyReady(value: unknown): value is RendererDraftPrewarmPolicy {
  return isRecord(value) && value.state === "ready" && typeof value.clear === "function";
}

export function modelSelectionForAgent(
  officialSelection: ModelPowerSelection | null,
  reasoningEffort: unknown,
  agent: RendererAgent,
  model?: HarnessModelRef,
): ModelPowerSelection | null {
  const transportModelId =
    agent === "pi" ? piTransportModelId(model) : transportModelIdForAgent(agent);
  return transportModelId ? { model: transportModelId, reasoningEffort } : officialSelection;
}

export function installCurrentRendererAdapter(): {
  status: RendererAdapterStatus;
  modelControl: RendererModelClient | null;
  applyAgent(agent: RendererAgent, model?: HarnessModelRef): boolean;
  applyPiModel(model: HarnessModelRef): boolean;
  dispose(): void;
} {
  let disposed = false;
  let modelController: ModelStateController | null = null;
  let officialSelection: ModelPowerSelection | null = null;
  let hasOfficialSelection = false;
  let selectedAgent: RendererAgent = "codex";
  let modelUpdates = 0;
  const liveStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    decoratedRequests: 0,
    modelUpdates: 0,
    candidateCount: 0,
    candidates: [],
    hook: null,
  };
  const updateStatus = (
    state: RendererAdapterState,
    reason: RendererAdapterStatus["reason"],
    hook: RendererAdapterStatus["hook"],
  ): void => {
    liveStatus.state = state;
    liveStatus.reason = reason;
    liveStatus.modelUpdates = modelUpdates;
    liveStatus.hook = hook;
    window.dispatchEvent(new CustomEvent("codexhost:renderer-adapter-status"));
  };

  const unsupportedResult = () => ({
    status: liveStatus,
    modelControl: null,
    applyAgent: () => false,
    applyPiModel: () => false,
    dispose() {},
  });
  const modelControl: RendererModelClient = Object.freeze({
    async inspectPi(input: PiHarnessInspectParams) {
      const client = createRendererModelClient(findActivePrewarmTargets(document));
      if (!client) throw new Error("Renderer Model request manager is unavailable");
      return client.inspectPi(input);
    },
    async inspectThread(input: ThreadInspectionParams) {
      const client = createRendererModelClient(findActivePrewarmTargets(document));
      if (!client) throw new Error("Renderer Model request manager is unavailable");
      return client.inspectThread(input);
    },
    async selectPiThreadModel(input: ThreadModelSelectParams) {
      const client = createRendererModelClient(findActivePrewarmTargets(document));
      if (!client) throw new Error("Renderer Model request manager is unavailable");
      return client.selectPiThreadModel(input);
    },
  });
  if (!isMainProcessTitlePolicyReady(window.__codexhostMainProcessTitlePolicyV1)) {
    updateStatus("unsupported", "title-policy-unavailable", null);
    return unsupportedResult();
  }
  if (!isDraftPrewarmPolicyReady(window.__codexhostDraftPrewarmPolicyV1)) {
    updateStatus("unsupported", "draft-prewarm-policy-unavailable", null);
    return unsupportedResult();
  }

  const captureController = (): boolean => {
    const discovered = findModelStateController();
    if (!discovered) return false;
    modelController = discovered;
    if (
      selectedAgent === "codex" &&
      (discovered.current === null || !isTransportModelId(discovered.current.model))
    ) {
      officialSelection = discovered.current;
      hasOfficialSelection = true;
    }
    if (!hasOfficialSelection) return false;
    updateStatus("ready", "ready", "model-state");
    return true;
  };
  const applyAgent = (agent: RendererAgent, model?: HarnessModelRef): boolean => {
    if (disposed) return false;
    if (agent === "codex" && !hasOfficialSelection) {
      selectedAgent = "codex";
      return true;
    }
    const controller = modelController ?? findModelStateController();
    if (!controller || !hasOfficialSelection) {
      updateStatus("unsupported", "model-controller-unavailable", null);
      return false;
    }
    modelController = controller;
    controller.apply(
      modelSelectionForAgent(officialSelection, controller.reasoningEffort, agent, model),
    );
    selectedAgent = agent;
    modelUpdates += 1;
    liveStatus.modelUpdates = modelUpdates;
    return true;
  };

  if (!captureController()) {
    updateStatus("unsupported", "model-controller-unavailable", null);
  }
  const observer = new MutationObserver(() => {
    captureController();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return {
    status: liveStatus,
    modelControl,
    applyAgent,
    applyPiModel(model) {
      if (selectedAgent !== "pi") return false;
      return applyAgent("pi", model);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      modelController = null;
      officialSelection = null;
      hasOfficialSelection = false;
    },
  };
}
