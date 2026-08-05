import {
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  type ExternalThreadForkParams,
  type HarnessInspectParams,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostThreadId,
  type ThreadInspectionParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { installRendererForkControl } from "./renderer-fork-control.js";
import { createRendererModelClient, type RendererModelClient } from "./renderer-model-client.js";

export const PI_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_TRANSPORT_MODEL_PREFIX = `${PI_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
export const CLAUDE_CODE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_TRANSPORT_MODEL_ID}@`;

export type RendererAdapterState = "installing" | "ready" | "unsupported";

export interface LockedComposerSelection {
  agent: RendererAgent;
  composerId: string;
  phase: "locked";
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

export interface RendererAdapterStatus {
  state: RendererAdapterState;
  reason:
    | "installing"
    | "ready"
    | "asset-import-failed"
    | "installation-failed"
    | "title-policy-unavailable"
    | "draft-prewarm-policy-unavailable"
    | "draft-prewarm-clear-failed"
    | "model-controller-unavailable";
  modelUpdates: number;
  hook: "model-state" | null;
}

type RendererAdapterStatusTransition = Pick<RendererAdapterStatus, "state" | "reason" | "hook">;

export function transitionRendererAdapterStatus(
  current: RendererAdapterStatus,
  next: RendererAdapterStatusTransition,
  publish: () => void,
): boolean {
  if (
    current.state === next.state &&
    current.reason === next.reason &&
    current.hook === next.hook
  ) {
    return false;
  }
  current.state = next.state;
  current.reason = next.reason;
  current.hook = next.hook;
  publish();
  return true;
}

interface PrewarmTarget {
  prewarmThreadStart?: (params: unknown, options?: unknown) => Promise<unknown> | unknown;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: PrewarmTarget;
}

export interface ModelPowerSelection {
  model: unknown;
  reasoningEffort: unknown;
  [key: string]: unknown;
}

export interface ModelStateController {
  apply(selection: ModelPowerSelection | null): void;
  codexSelection: ModelPowerSelection | null;
  current: ModelPowerSelection | null;
  format: "legacy" | "compact";
  reasoningEffort: unknown;
}

export interface ModelAtomState {
  atom: object;
  get(): unknown;
  set(value: unknown): unknown;
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
  return isPiTransportModelId(model) || isClaudeTransportModelId(model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function piTransportModelId(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("Pi transport Thinking requires a Model Ref");
    return PI_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return `${PI_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
}

export function claudeTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Claude Code transport configuration requires a Model Ref");
    }
    return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinkingOption = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinkingOption) {
    return `${CLAUDE_CODE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode ?? ""}@${parsedThinkingOption}`;
  }
  return `${CLAUDE_CODE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionMode ? `@${parsedPermissionMode}` : ""}`;
}

export function decodeClaudeTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  if (value === CLAUDE_CODE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(CLAUDE_CODE_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(CLAUDE_CODE_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) return null;
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) return null;
  if (components.length === 3 && !thinkingOptionId) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) return null;
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) return null;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) return null;
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function isClaudeTransportModelId(value: unknown): value is string {
  return decodeClaudeTransportModelId(value) !== null;
}

export function isPiTransportModelId(value: unknown): value is string {
  if (value === PI_TRANSPORT_MODEL_ID) return true;
  if (typeof value !== "string" || !value.startsWith(PI_TRANSPORT_MODEL_PREFIX)) return false;
  const components = value.slice(PI_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) return false;
  const [modelId, thinkingOptionId] = components;
  if (!harnessModelRefSchema.safeParse({ id: modelId }).success) return false;
  return (
    components.length === 1 ||
    (thinkingOptionId !== undefined &&
      harnessThinkingOptionIdSchema.safeParse(thinkingOptionId).success)
  );
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

function isModelAtomState(value: unknown): value is ModelAtomState {
  return (
    isRecord(value) &&
    isRecord(value.atom) &&
    typeof value.get === "function" &&
    typeof value.set === "function"
  );
}

function isModelSelection(value: unknown): value is ModelPowerSelection | null {
  return value === null || (isRecord(value) && "model" in value && "reasoningEffort" in value);
}

export function sameModelPowerSelection(
  left: ModelPowerSelection | null,
  right: ModelPowerSelection | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.model === right.model &&
      left.reasoningEffort === right.reasoningEffort)
  );
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function selectOptimisticModelAtom(pairs: readonly ModelAtomPair[]): ModelAtomState | null {
  const first = pairs[0];
  if (!first) return null;
  const value = first.optimistic.get();
  if (isRecord(value) && "modelSettings" in value) return first.optimistic;
  if (first.optimistic.atom === first.committed.atom) return null;
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

function findModelPickerControl(composer?: Element): {
  codexSelection: ModelPowerSelection | null;
  found: boolean;
  selection: ModelPowerSelection;
  selectModel(model: unknown, reasoningEffort: unknown): void;
} {
  let control:
    | {
        codexSelection: ModelPowerSelection | null;
        selection: ModelPowerSelection;
        selectModel(model: unknown, reasoningEffort: unknown): void;
      }
    | undefined;
  for (const button of (composer ?? document).querySelectorAll<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
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
        !control &&
        isRecord(props) &&
        "model" in props &&
        "reasoningEffort" in props &&
        typeof props.onSelectModel === "function"
      ) {
        const selection = { model: props.model, reasoningEffort: props.reasoningEffort };
        const fallbackSelection = isRecord(props.fallbackPowerSelection)
          ? (props.fallbackPowerSelection as ModelPowerSelection)
          : null;
        control = {
          codexSelection: isTransportModelId(selection.model) ? fallbackSelection : selection,
          selection,
          selectModel: props.onSelectModel as (model: unknown, reasoningEffort: unknown) => void,
        };
      }
      const parent = fiber.return;
      fiber =
        (typeof parent === "object" || typeof parent === "function") && parent !== null
          ? (parent as typeof fiber)
          : null;
    }
  }
  return {
    codexSelection: control?.codexSelection ?? null,
    found: control !== undefined,
    selection: control?.selection ?? { model: undefined, reasoningEffort: undefined },
    selectModel(model, reasoningEffort) {
      control?.selectModel(model, reasoningEffort);
    },
  };
}

function findModelAtomPairs(composer?: Element): ModelAtomPair[] {
  const pairs: ModelAtomPair[] = [];
  const compactPairs: ModelAtomPair[] = [];
  let fiber = findComposerFiber(composer);
  for (let depth = 0; fiber && depth < 120; depth += 1) {
    const updateQueue = fiber.updateQueue;
    const memoCache = isRecord(updateQueue) ? updateQueue.memoCache : null;
    const data = isRecord(memoCache) && Array.isArray(memoCache.data) ? memoCache.data : [];
    for (let index = 0; index + 1 < data.length; index += 1) {
      const compact = data[index];
      const resolved = data[index + 1];
      if (
        !Array.isArray(compact) ||
        !isModelAtomState(compact[1]) ||
        !Array.isArray(resolved) ||
        !isModelAtomState(resolved[3]) ||
        (resolved[2] !== null && typeof resolved[2] !== "string")
      ) {
        continue;
      }
      let value: unknown;
      try {
        value = compact[1].get();
      } catch {
        continue;
      }
      if (!isRecord(value) || !("modelSettings" in value)) continue;
      const target =
        resolved[2] === null || resolved[2].startsWith("client-new-thread:")
          ? ["default", resolved[2]]
          : ["conversation", resolved[2]];
      compactPairs.push({ optimistic: compact[1], committed: resolved[3], target });
    }
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
  return pairs.length > 0 ? pairs : compactPairs;
}

export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const pairs = findModelAtomPairs(composer);
  if (!selectOptimisticModelAtom(pairs)) return null;
  return pairs[0]?.target ?? null;
}

function findModelStateController(composer?: Element): ModelStateController | null {
  const pairs = findModelAtomPairs(composer);
  const optimistic = selectOptimisticModelAtom(pairs);
  if (!optimistic) return null;
  const current = optimistic.get();
  if (isModelSelection(current)) {
    const reasoningEffort = findReasoningEffort();
    const picker = findModelPickerControl(composer);
    if (!reasoningEffort.found) return null;
    return {
      apply(selection) {
        optimistic.set(selection);
      },
      codexSelection:
        current === null
          ? picker.codexSelection
          : !isTransportModelId(current.model)
            ? current
            : picker.codexSelection,
      get current() {
        const value = optimistic.get();
        return isModelSelection(value) ? value : null;
      },
      format: "legacy",
      reasoningEffort: reasoningEffort.value,
    };
  }
  if (!isRecord(current) || !("modelSettings" in current)) return null;
  const picker = findModelPickerControl(composer);
  if (!picker.found) return null;
  return {
    apply(selection) {
      if (selection) picker.selectModel(selection.model, selection.reasoningEffort);
      else optimistic.set({ ...current, isManuallyChanged: true, modelSettings: null });
    },
    codexSelection: picker.codexSelection,
    current: picker.selection,
    format: "compact",
    reasoningEffort: picker.selection.reasoningEffort,
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
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
): ModelPowerSelection | null {
  const transportModelId =
    agent === "pi"
      ? piTransportModelId(model, thinkingOptionId)
      : agent === "claude-code"
        ? claudeTransportModelId(model, permissionModeId, thinkingOptionId)
        : transportModelIdForAgent(agent);
  return transportModelId ? { model: transportModelId, reasoningEffort } : officialSelection;
}

export function installCurrentRendererAdapter(): {
  status: RendererAdapterStatus;
  modelControl: RendererModelClient | null;
  applyAgent(
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    composer?: Element,
  ): boolean;
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
    modelUpdates: 0,
    hook: null,
  };
  const updateStatus = (
    state: RendererAdapterState,
    reason: RendererAdapterStatus["reason"],
    hook: RendererAdapterStatus["hook"],
  ): void => {
    liveStatus.modelUpdates = modelUpdates;
    transitionRendererAdapterStatus(liveStatus, { state, reason, hook }, () => {
      window.dispatchEvent(new CustomEvent("codexhost:renderer-adapter-status"));
    });
  };

  const unsupportedResult = () => ({
    status: liveStatus,
    modelControl: null,
    applyAgent: () => false,
    dispose() {},
  });
  const currentModelClient = (): RendererModelClient => {
    const client = createRendererModelClient(findActivePrewarmTargets(document));
    if (!client) throw new Error("Renderer Model request manager is unavailable");
    return client;
  };
  const modelControl: RendererModelClient = Object.freeze({
    forkThread: (input: ExternalThreadForkParams) => currentModelClient().forkThread(input),
    inspectHarness: (input: HarnessInspectParams) => currentModelClient().inspectHarness(input),
    inspectThread: (input: ThreadInspectionParams) => currentModelClient().inspectThread(input),
    listThreadOwnership: (input: ThreadOwnershipListParams) =>
      currentModelClient().listThreadOwnership(input),
    selectThreadModel: (input: ThreadModelSelectParams) =>
      currentModelClient().selectThreadModel(input),
    selectThreadThinking: (input: ThreadThinkingSelectParams) =>
      currentModelClient().selectThreadThinking(input),
    selectThreadPermissionMode: (input: ThreadPermissionModeSelectParams) =>
      currentModelClient().selectThreadPermissionMode(input),
  });
  if (!isMainProcessTitlePolicyReady(window.__codexhostMainProcessTitlePolicyV1)) {
    updateStatus("unsupported", "title-policy-unavailable", null);
    return unsupportedResult();
  }
  if (!isDraftPrewarmPolicyReady(window.__codexhostDraftPrewarmPolicyV1)) {
    updateStatus("unsupported", "draft-prewarm-policy-unavailable", null);
    return unsupportedResult();
  }
  const forkControl = installRendererForkControl({
    getClient: () => modelControl,
    reportError: (error) => {
      console.error(
        "codexhost external Thread Fork failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  });

  const captureController = (): boolean => {
    const discovered = findModelStateController();
    if (!discovered) return false;
    modelController = discovered;
    if (selectedAgent === "codex" && discovered.codexSelection !== null) {
      officialSelection = discovered.codexSelection;
      hasOfficialSelection = true;
    } else if (selectedAgent === "codex" && discovered.current === null) {
      officialSelection = null;
      hasOfficialSelection = true;
    }
    if (!hasOfficialSelection) return false;
    updateStatus("ready", "ready", "model-state");
    return true;
  };
  const applyAgent = (
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    composer?: Element,
  ): boolean => {
    if (disposed) return false;
    if (agent === "codex" && !hasOfficialSelection) {
      selectedAgent = "codex";
      return true;
    }
    const scopedController = composer ? findModelStateController(composer) : null;
    const controller =
      scopedController ??
      (modelController?.format === "legacy"
        ? modelController
        : composer
          ? null
          : (modelController ?? findModelStateController()));
    if (!controller || !hasOfficialSelection) return false;
    modelController = controller;
    const selection = modelSelectionForAgent(
      officialSelection,
      controller.reasoningEffort,
      agent,
      model,
      thinkingOptionId,
      permissionModeId,
    );
    if (!sameModelPowerSelection(controller.current, selection)) {
      controller.apply(selection);
      modelUpdates += 1;
      liveStatus.modelUpdates = modelUpdates;
    }
    selectedAgent = agent;
    return true;
  };

  if (!captureController()) {
    updateStatus("installing", "model-controller-unavailable", null);
  }
  const observer = new MutationObserver(() => {
    captureController();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return {
    status: liveStatus,
    modelControl,
    applyAgent,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      forkControl.dispose();
      modelController = null;
      officialSelection = null;
      hasOfficialSelection = false;
    },
  };
}
