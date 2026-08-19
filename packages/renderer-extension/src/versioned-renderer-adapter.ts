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
  type ThreadCommandExecuteParams,
  type ThreadCommandsInspectParams,
  type ThreadInspectionParams,
  type ThreadModelSelectParams,
  type ThreadPermissionModeSelectParams,
  type ThreadThinkingSelectParams,
  type ThreadOwnershipListParams,
  type ThreadUsageInspection,
  type ThreadUsageInspectionParams,
} from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { installRendererForkControl } from "./renderer-fork-control.js";
import {
  createRendererModelClient,
  createThreadUsageSubscriptionRelay,
  type RendererModelClient,
} from "./renderer-model-client.js";

export const PI_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_TRANSPORT_MODEL_PREFIX = `${PI_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
export const CLAUDE_CODE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_TRANSPORT_MODEL_ID}@`;
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID = "codexhost/deepseek-harness-native";
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX = `${DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID}@`;
export const GROK_TRANSPORT_MODEL_ID = "codexhost/grok-native";
export const GROK_TRANSPORT_MODEL_PREFIX = `${GROK_TRANSPORT_MODEL_ID}@`;

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
    | "draft-prewarm-clear-failed"
    | "draft-routing-policy-unavailable";
  modelUpdates: number;
  hook: "request-bridge" | null;
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
  addNotificationCallback?: (
    method: string | readonly string[],
    callback: (notification: unknown) => void,
  ) => () => void;
  enqueueRequest?: (...args: unknown[]) => unknown;
  prewarmThreadStart?: (params: unknown, options?: unknown) => Promise<unknown> | unknown;
  sendRequest?: (method: string, params: unknown, options?: unknown) => Promise<unknown> | unknown;
  requestClient?: PrewarmTarget;
  hostId?: unknown;
}

export interface ModelPowerSelection {
  model: unknown;
  reasoningEffort: unknown;
  [key: string]: unknown;
}

export interface RendererDraftPrewarmPolicy {
  state: "ready";
  select(model: string | null): boolean;
  clear(): Promise<void>;
}

interface RendererDraftPrewarmPolicyTarget {
  __codexhostDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
  setTimeout(handler: TimerHandler, timeout?: number): number;
}

const DRAFT_PREWARM_POLICY_WAIT_TIMEOUT_MS = 10_000;
const DRAFT_PREWARM_POLICY_POLL_INTERVAL_MS = 25;

declare global {
  interface Window {
    __codexhostMainProcessTitlePolicyV1?: { state: "ready" };
    __codexhostDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
  }
}

function transportModelIdForAgent(agent: RendererAgent): string | null {
  if (agent === "pi") return PI_TRANSPORT_MODEL_ID;
  if (agent === "claude-code") return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  if (agent === "deepseek-harness") return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  if (agent === "grok") return GROK_TRANSPORT_MODEL_ID;
  return null;
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

export function grokTransportModelId(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("Grok transport Thinking requires a Model Ref");
    return GROK_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return `${GROK_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@@${parsedThinking}` : ""}`;
}

export function decodeGrokTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  if (value === GROK_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(GROK_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(GROK_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length !== 1 && components.length !== 3) return null;
  const [modelId, emptyPermissionMode, thinkingOptionId] = components;
  if (components.length === 3 && (emptyPermissionMode !== "" || !thinkingOptionId)) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) return null;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) return null;
  return {
    model: model.data,
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
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

export function isGrokTransportModelId(value: unknown): value is string {
  return decodeGrokTransportModelId(value) !== null;
}

export function isClaudeTransportModelId(value: unknown): value is string {
  return decodeClaudeTransportModelId(value) !== null;
}

export function deepSeekHarnessTransportModelId(model?: HarnessModelRef): string {
  if (!model) return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  return `${DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX}${harnessModelRefSchema.parse(model).id}`;
}

export function decodeDeepSeekHarnessTransportModelId(value: unknown): {
  model?: HarnessModelRef;
} | null {
  if (value === DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const model = harnessModelRefSchema.safeParse({
    id: value.slice(DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX.length),
  });
  return model.success ? { model: model.data } : null;
}

export function isDeepSeekHarnessTransportModelId(value: unknown): value is string {
  return decodeDeepSeekHarnessTransportModelId(value) !== null;
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
  const bridge = target.requestClient ?? target;
  const stableApiShape =
    bridge.hostId === "local" &&
    typeof bridge.sendRequest === "function" &&
    typeof bridge.prewarmThreadStart === "function" &&
    typeof bridge.enqueueRequest === "function";
  if (stableApiShape) return true;

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
          targets.add(typeof hookState.sendRequest === "function" ? hookState : requestClient);
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

function findComposerFiber(composer?: Element): {
  return?: unknown;
  updateQueue?: unknown;
  memoizedProps?: unknown;
} | null {
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
        memoizedProps?: unknown;
      } | null)
    : null;
}

function findComposerConversationThreadId(composer?: Element): HostThreadId | null | undefined {
  let threadId: HostThreadId | undefined;
  let fiber = findComposerFiber(composer);
  for (let depth = 0; fiber && depth < 120; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props) && "conversationId" in props && props.conversationId != null) {
      const candidate = hostThreadIdSchema.safeParse(props.conversationId);
      if (!candidate.success || (threadId !== undefined && threadId !== candidate.data)) {
        return null;
      }
      threadId = candidate.data;
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return threadId;
}

function isCurrentDraftWrapper(value: unknown): value is readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[3] !== value[5] ||
    value[3] !== value[6] ||
    !isRecord(value[3]) ||
    typeof value[3].get !== "function" ||
    (typeof value[2] !== "string" && value[2] !== null)
  ) {
    return false;
  }
  try {
    const draft = value[3].get();
    return isRecord(draft) && "modelSettings" in draft && "isManuallyChanged" in draft;
  } catch {
    return false;
  }
}

export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const conversationThreadId = findComposerConversationThreadId(composer);
  if (conversationThreadId === null) return null;
  if (conversationThreadId !== undefined) return ["conversation", conversationThreadId];

  const draftIds = new Set<string>();
  let fiber = findComposerFiber(composer);
  for (let depth = 0; fiber && depth < 120; depth += 1) {
    const updateQueue = fiber.updateQueue;
    const memoCache = isRecord(updateQueue) ? updateQueue.memoCache : null;
    const data = isRecord(memoCache) && Array.isArray(memoCache.data) ? memoCache.data : [];
    for (const value of data) {
      if (
        isCurrentDraftWrapper(value) &&
        typeof value[2] === "string" &&
        value[2].startsWith("client-new-thread:")
      ) {
        draftIds.add(value[2]);
      }
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  if (draftIds.size !== 1) return null;
  return ["default", draftIds.values().next().value];
}

export function isMainProcessTitlePolicyReady(value: unknown): boolean {
  return isRecord(value) && value.state === "ready";
}

export function isDraftPrewarmPolicyReady(value: unknown): value is RendererDraftPrewarmPolicy {
  return (
    isRecord(value) &&
    value.state === "ready" &&
    typeof value.select === "function" &&
    typeof value.clear === "function"
  );
}

export async function waitForRendererDraftPrewarmPolicy(
  target: RendererDraftPrewarmPolicyTarget,
): Promise<RendererDraftPrewarmPolicy> {
  const deadline = Date.now() + DRAFT_PREWARM_POLICY_WAIT_TIMEOUT_MS;
  while (true) {
    const policy = target.__codexhostDraftPrewarmPolicyV1;
    if (isDraftPrewarmPolicyReady(policy)) return policy;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Renderer draft prewarm policy is unavailable");
    await new Promise<void>((resolve) => {
      target.setTimeout(resolve, Math.min(DRAFT_PREWARM_POLICY_POLL_INTERVAL_MS, remaining));
    });
  }
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
        : agent === "deepseek-harness"
          ? deepSeekHarnessTransportModelId(model)
          : agent === "grok"
            ? grokTransportModelId(model, thinkingOptionId)
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
  const usageSubscription = createThreadUsageSubscriptionRelay();
  const currentModelClient = (): RendererModelClient => {
    const client = createRendererModelClient(findActivePrewarmTargets(document));
    if (!client) throw new Error("Renderer Model request manager is unavailable");
    usageSubscription.connect(client);
    return client;
  };
  const modelControl: RendererModelClient = Object.freeze({
    forkThread: (input: ExternalThreadForkParams) => currentModelClient().forkThread(input),
    inspectHarness: (input: HarnessInspectParams) => currentModelClient().inspectHarness(input),
    inspectThread: (input: ThreadInspectionParams) => currentModelClient().inspectThread(input),
    inspectThreadCommands: (input: ThreadCommandsInspectParams) =>
      currentModelClient().inspectThreadCommands(input),
    executeThreadCommand: (input: ThreadCommandExecuteParams) =>
      currentModelClient().executeThreadCommand(input),
    inspectThreadUsage: (input: ThreadUsageInspectionParams) =>
      currentModelClient().inspectThreadUsage(input),
    subscribeThreadUsage: (listener: (update: ThreadUsageInspection) => void) =>
      usageSubscription.subscribe(listener),
    listThreadOwnership: (input: ThreadOwnershipListParams) =>
      currentModelClient().listThreadOwnership(input),
    selectThreadModel: (input: ThreadModelSelectParams) =>
      currentModelClient().selectThreadModel(input),
    selectThreadThinking: (input: ThreadThinkingSelectParams) =>
      currentModelClient().selectThreadThinking(input),
    selectThreadPermissionMode: (input: ThreadPermissionModeSelectParams) =>
      currentModelClient().selectThreadPermissionMode(input),
    checkUpdate: () => currentModelClient().checkUpdate(),
    startUpdate: () => currentModelClient().startUpdate(),
    readUpdateStatus: () => currentModelClient().readUpdateStatus(),
  });
  if (!isMainProcessTitlePolicyReady(window.__codexhostMainProcessTitlePolicyV1)) {
    updateStatus("unsupported", "title-policy-unavailable", null);
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

  let routingPolicy: RendererDraftPrewarmPolicy | null = null;
  let policyTimer: number | null = null;
  const captureRoutingPolicy = (): boolean => {
    const discovered = window.__codexhostDraftPrewarmPolicyV1;
    if (!isDraftPrewarmPolicyReady(discovered)) return false;
    routingPolicy = discovered;
    if (policyTimer !== null) {
      window.clearInterval(policyTimer);
      policyTimer = null;
    }
    updateStatus("ready", "ready", "request-bridge");
    return true;
  };
  if (!captureRoutingPolicy()) {
    updateStatus("installing", "draft-routing-policy-unavailable", null);
    policyTimer = window.setInterval(captureRoutingPolicy, DRAFT_PREWARM_POLICY_POLL_INTERVAL_MS);
  }

  const applyAgent = (
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    if (disposed || routingPolicy === null) return false;
    const selection = modelSelectionForAgent(
      null,
      null,
      agent,
      model,
      thinkingOptionId,
      permissionModeId,
    );
    const carrier = selection?.model;
    if (carrier !== null && carrier !== undefined && typeof carrier !== "string") return false;
    if (routingPolicy.select(carrier ?? null)) {
      modelUpdates += 1;
      liveStatus.modelUpdates = modelUpdates;
    }
    return true;
  };
  return {
    status: liveStatus,
    modelControl,
    applyAgent,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (policyTimer !== null) window.clearInterval(policyTimer);
      routingPolicy?.select(null);
      routingPolicy = null;
      forkControl.dispose();
      usageSubscription.dispose();
    },
  };
}
