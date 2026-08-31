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
export const OMP_TRANSPORT_MODEL_ID = "codexhost/omp-native";
export const OMP_TRANSPORT_MODEL_PREFIX = `${OMP_TRANSPORT_MODEL_ID}@`;

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
  getHostId?: () => unknown;
}

export interface ModelPowerSelection {
  model: unknown;
  reasoningEffort: unknown;
  [key: string]: unknown;
}

export interface RendererDraftPrewarmPolicy {
  state: "ready";
  hostId: string;
  readonly requestTarget?: () => unknown;
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
  if (agent === "omp") return OMP_TRANSPORT_MODEL_ID;
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

export function ompTransportModelId(
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (thinkingOptionId) throw new Error("OMP transport Thinking requires a Model Ref");
    return OMP_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  return `${OMP_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
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
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Grok transport configuration requires a Model Ref");
    }
    return GROK_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${GROK_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode ?? ""}@${parsedThinking}`;
  }
  return `${GROK_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionMode ? `@${parsedPermissionMode}` : ""}`;
}

export function decodeGrokTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  if (value === GROK_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(GROK_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(GROK_TRANSPORT_MODEL_PREFIX.length).split("@");
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

export function deepSeekHarnessTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId) {
      throw new Error("DeepSeek Harness transport Permission Mode requires a Model Ref");
    }
    return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  }
  const parsedPermissionModeId = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  return `${DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX}${harnessModelRefSchema.parse(model).id}${parsedPermissionModeId ? `@${parsedPermissionModeId}` : ""}`;
}

export function decodeDeepSeekHarnessTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  if (value === DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) return null;
  const [modelId, permissionModeId] = components;
  if (components.length === 2 && !permissionModeId) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) return null;
  const permissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (permissionMode && !permissionMode.success) return null;
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
  };
}

export function isDeepSeekHarnessTransportModelId(value: unknown): value is string {
  return decodeDeepSeekHarnessTransportModelId(value) !== null;
}

export function decodePiTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  if (value === PI_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(PI_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(PI_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) return null;
  const [modelId, thinkingOptionId] = components;
  if (components.length === 2 && !thinkingOptionId) return null;
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

export function isPiTransportModelId(value: unknown): value is string {
  return decodePiTransportModelId(value) !== null;
}

export function decodeOmpTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  if (value === OMP_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OMP_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(OMP_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 2) return null;
  const [modelId, thinkingOptionId] = components;
  if (components.length === 2 && !thinkingOptionId) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) return null;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) return null;
  return { model: model.data, ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}) };
}

export function isOmpTransportModelId(value: unknown): value is string {
  return decodeOmpTransportModelId(value) !== null;
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

function isCurrentRequestBridge(value: unknown): value is PrewarmTarget {
  return (
    isRecord(value) &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.sendRequest === "function" &&
    typeof value.prewarmThreadStart === "function" &&
    typeof value.enqueueRequest === "function"
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
        const bridge = isCurrentRequestBridge(requestClient)
          ? requestClient
          : isCurrentRequestBridge(hookState)
            ? hookState
            : null;
        if (bridge) {
          targets.add(typeof hookState.sendRequest === "function" ? hookState : bridge);
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

type ComposerDomIdentity =
  | { kind: "unsupported" }
  | { kind: "draft" }
  | { kind: "conversation"; threadId: HostThreadId }
  | { kind: "ambiguous" };

function findComposerDomIdentity(composer: Element): ComposerDomIdentity {
  // Codex 26.818 renders one direct portal marker inside the Composer root. The
  // conversation attribute is omitted for an unsubmitted client-new-thread and
  // populated once that draft is bound to a real Thread. Prefer this scoped DOM
  // contract over arbitrary ancestor props: remote project pages can carry a
  // background/prewarm conversationId above an otherwise-new Composer.
  const children = Array.from(composer.children ?? []);
  const portals = children.filter((child) => child.hasAttribute("data-above-composer-portal"));
  if (portals.length === 0) return { kind: "unsupported" };
  if (portals.length !== 1) return { kind: "ambiguous" };

  const value = portals[0]?.getAttribute("data-above-composer-conversation-id");
  if (value === null) return { kind: "draft" };
  const candidate = hostThreadIdSchema.safeParse(value);
  return candidate.success
    ? { kind: "conversation", threadId: candidate.data }
    : { kind: "ambiguous" };
}

function findComposerDraftIds(composer: Element): Set<string> {
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
  return draftIds;
}

export function findComposerModelTarget(composer: Element): readonly unknown[] | null {
  const draftIds = findComposerDraftIds(composer);
  const domIdentity = findComposerDomIdentity(composer);
  if (domIdentity.kind === "ambiguous") return null;
  if (domIdentity.kind === "conversation") {
    return ["conversation", domIdentity.threadId];
  }
  if (domIdentity.kind === "draft") {
    return draftIds.size === 1 ? ["default", draftIds.values().next().value] : null;
  }

  // Older supported Desktop builds do not expose the scoped portal marker.
  // Retain their reviewed Fiber fallback, including fail-closed ambiguity.
  const conversationThreadId = findComposerConversationThreadId(composer);
  if (conversationThreadId === null) return null;
  if (conversationThreadId !== undefined) return ["conversation", conversationThreadId];

  if (draftIds.size !== 1) return null;
  return ["default", draftIds.values().next().value];
}

export type RendererComposerModelContractState = "draft" | "conversation" | "missing" | "ambiguous";

export function inspectComposerModelContract(
  composer: Element,
): RendererComposerModelContractState {
  const target = findComposerModelTarget(composer);
  if (target?.[0] === "default") return "draft";
  if (target?.[0] === "conversation") return "conversation";
  const domIdentity = findComposerDomIdentity(composer);
  if (domIdentity.kind === "ambiguous") return "ambiguous";
  return "missing";
}

export function isMainProcessTitlePolicyReady(value: unknown): boolean {
  return isRecord(value) && value.state === "ready";
}

export function isDraftPrewarmPolicyReady(value: unknown): value is RendererDraftPrewarmPolicy {
  return (
    isRecord(value) &&
    value.state === "ready" &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    typeof value.select === "function" &&
    typeof value.clear === "function"
  );
}

export function activeRendererDraftPrewarmPolicy(
  policy: unknown,
  targets: readonly PrewarmTarget[],
): RendererDraftPrewarmPolicy | null {
  if (!isDraftPrewarmPolicyReady(policy)) return null;
  return activeRendererDraftPrewarmTargets(policy, targets) ? policy : null;
}

function prewarmTargetHostId(target: PrewarmTarget): string | null {
  const bridge = target.requestClient ?? target;
  const hostId = target.getHostId?.() ?? bridge.hostId;
  return typeof hostId === "string" && hostId.length > 0 ? hostId : null;
}

function isRendererRequestTarget(value: unknown): value is PrewarmTarget {
  if (!isRecord(value) || typeof value.sendRequest !== "function") return false;
  return isCurrentRequestBridge(value.requestClient ?? value);
}

function hasPolicyRequestTarget(policy: RendererDraftPrewarmPolicy): boolean {
  return "requestTarget" in policy;
}

function exactRendererRequestTarget(
  policy: RendererDraftPrewarmPolicy,
): readonly PrewarmTarget[] | null {
  if (typeof policy.requestTarget !== "function") return null;
  try {
    const target = policy.requestTarget();
    if (!isRendererRequestTarget(target) || prewarmTargetHostId(target) !== policy.hostId) {
      return null;
    }
    return [target];
  } catch {
    return null;
  }
}

export function rendererRequestTargetsForHost(
  targets: readonly PrewarmTarget[],
  hostId: string,
): readonly PrewarmTarget[] | null {
  const matching = targets.filter((target) => prewarmTargetHostId(target) === hostId);
  return matching.length === 1 ? matching : null;
}

function activeRendererDraftPrewarmTargets(
  policy: unknown,
  targets: readonly PrewarmTarget[],
): readonly PrewarmTarget[] | null {
  if (!isDraftPrewarmPolicyReady(policy)) return null;
  if (hasPolicyRequestTarget(policy)) return exactRendererRequestTarget(policy);
  return rendererRequestTargetsForHost(targets, policy.hostId);
}

export interface RendererRequestRoute {
  readonly policy: RendererDraftPrewarmPolicy;
  readonly targets: readonly PrewarmTarget[];
}

export function resolveRendererRequestRoute(
  policy: unknown,
  discoveredTargets: readonly PrewarmTarget[],
  previous: RendererRequestRoute | null,
): RendererRequestRoute | null {
  const activeTargets = activeRendererDraftPrewarmTargets(policy, discoveredTargets);
  if (isDraftPrewarmPolicyReady(policy) && activeTargets) {
    return { policy, targets: activeTargets };
  }

  if (isDraftPrewarmPolicyReady(policy) && hasPolicyRequestTarget(policy)) return null;

  // Composer replacement and settings overlays can briefly remove the only
  // Fiber path that exposes the request manager. Retain the confirmed route
  // only while discovery is empty and the installed policy object is unchanged.
  // Positive discovery for another Host invalidates the cache immediately;
  // policy identity also prevents reuse across reconnects or same-id switches.
  return discoveredTargets.length === 0 &&
    isDraftPrewarmPolicyReady(policy) &&
    previous?.policy === policy
    ? previous
    : null;
}

export function createRendererRequestRouteResolver(
  readPolicy: () => unknown,
  discoverTargets: () => readonly PrewarmTarget[],
): {
  resolve(): RendererRequestRoute | null;
  clear(): void;
} {
  let route: RendererRequestRoute | null = null;
  return {
    resolve() {
      // Persist null invalidations too, otherwise a later empty discovery gap
      // could revive a request manager that belonged to the previous Host.
      const policy = readPolicy();
      const discoveredTargets =
        isDraftPrewarmPolicyReady(policy) && hasPolicyRequestTarget(policy)
          ? []
          : discoverTargets();
      route = resolveRendererRequestRoute(policy, discoveredTargets, route);
      return route;
    },
    clear() {
      route = null;
    },
  };
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
          ? deepSeekHarnessTransportModelId(model, permissionModeId)
          : agent === "grok"
            ? grokTransportModelId(model, permissionModeId, thinkingOptionId)
            : agent === "omp"
              ? ompTransportModelId(model, thinkingOptionId)
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
  const requestRouteResolver = createRendererRequestRouteResolver(
    () => window.__codexhostDraftPrewarmPolicyV1,
    () => findActivePrewarmTargets(document),
  );
  const clientsByTarget = new WeakMap<PrewarmTarget, RendererModelClient>();
  const modelClientForTargets = (targets: readonly PrewarmTarget[]): RendererModelClient | null => {
    const target = targets[0];
    if (targets.length !== 1 || !target) return null;
    const cached = clientsByTarget.get(target);
    if (cached) return cached;
    const client = createRendererModelClient([target]);
    if (client) clientsByTarget.set(target, client);
    return client;
  };
  let activeRoutePolicy: RendererDraftPrewarmPolicy | null = null;
  let activeRouteClient: RendererModelClient | null = null;
  const syncActiveRoute = (route: RendererRequestRoute | null): RendererModelClient | null => {
    const policy = route?.policy ?? null;
    const client = route ? modelClientForTargets(route.targets) : null;
    if (activeRoutePolicy === policy && activeRouteClient === client) return client;
    activeRoutePolicy = policy;
    activeRouteClient = client;
    return client;
  };
  const currentRequestRoute = (): RendererRequestRoute | null => {
    const route = requestRouteResolver.resolve();
    syncActiveRoute(route);
    return route;
  };
  const currentModelClient = (): RendererModelClient => {
    const client = currentRequestRoute() ? activeRouteClient : null;
    if (!client) throw new Error("Renderer Model request manager is unavailable");
    usageSubscription.connect(client);
    return client;
  };
  const modelControl: RendererModelClient = Object.freeze({
    currentHostId: () => currentRequestRoute()?.policy.hostId ?? null,
    clientForHost(hostId: string): RendererModelClient | null {
      const route = currentRequestRoute();
      if (route?.policy.hostId === hostId) return modelClientForTargets(route.targets);
      const targets = rendererRequestTargetsForHost(findActivePrewarmTargets(document), hostId);
      const client = modelClientForTargets(targets ?? []);
      if (client) return client;
      const policy = window.__codexhostDraftPrewarmPolicyV1;
      if (isDraftPrewarmPolicyReady(policy) && hasPolicyRequestTarget(policy)) return null;
      return null;
    },
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
  let policyRecaptureObserver: MutationObserver | null = null;
  let hasCapturedRoutingPolicy = false;
  let selectedRoutingPolicy: RendererDraftPrewarmPolicy | null = null;
  let selectedCarrier: string | null = null;
  let desiredCarrier: string | null = null;
  const stopPolicyCapture = (): void => {
    if (policyTimer === null) return;
    window.clearInterval(policyTimer);
    policyTimer = null;
  };
  const stopPolicyRecapture = (): void => {
    policyRecaptureObserver?.disconnect();
    policyRecaptureObserver = null;
  };
  const captureRoutingPolicy = (): boolean => {
    const route = currentRequestRoute();
    if (!route) return false;
    routingPolicy = route.policy;
    stopPolicyRecapture();
    if (selectedRoutingPolicy !== routingPolicy || selectedCarrier !== desiredCarrier) {
      try {
        routingPolicy.select(desiredCarrier);
      } catch {
        updateStatus("installing", "draft-routing-policy-unavailable", null);
        return false;
      }
      selectedRoutingPolicy = routingPolicy;
      selectedCarrier = desiredCarrier;
    }
    hasCapturedRoutingPolicy = true;
    stopPolicyCapture();
    updateStatus("ready", "ready", "request-bridge");
    return true;
  };
  const startPolicyCapture = (): void => {
    stopPolicyCapture();
    policyTimer = window.setInterval(captureRoutingPolicy, DRAFT_PREWARM_POLICY_POLL_INTERVAL_MS);
  };
  const startPolicyRecapture = (): void => {
    stopPolicyRecapture();
    policyRecaptureObserver = new MutationObserver(() => {
      captureRoutingPolicy();
    });
    policyRecaptureObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-codex-composer-root"],
      characterData: true,
      childList: true,
      subtree: true,
    });
  };
  if (!captureRoutingPolicy()) {
    updateStatus("installing", "draft-routing-policy-unavailable", null);
    const policy = window.__codexhostDraftPrewarmPolicyV1;
    if (!isDraftPrewarmPolicyReady(policy) || !hasPolicyRequestTarget(policy)) {
      startPolicyCapture();
    }
  }
  const handleRoutingPolicyChange = (): void => {
    stopPolicyRecapture();
    if (captureRoutingPolicy()) return;
    const policy = window.__codexhostDraftPrewarmPolicyV1;
    if (isDraftPrewarmPolicyReady(policy) && hasPolicyRequestTarget(policy)) {
      stopPolicyCapture();
    }
    if (!hasCapturedRoutingPolicy) return;
    updateStatus("installing", "draft-routing-policy-unavailable", null);
    if (isDraftPrewarmPolicyReady(policy) && !hasPolicyRequestTarget(policy)) {
      startPolicyRecapture();
    }
  };
  window.addEventListener("codexhost:draft-prewarm-policy-changed", handleRoutingPolicyChange);

  const applyAgent = (
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    if (disposed) return false;
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
    desiredCarrier = carrier ?? null;
    const route = currentRequestRoute();
    if (!route) return false;
    routingPolicy = route.policy;
    try {
      if (route.policy.select(desiredCarrier)) {
        modelUpdates += 1;
        liveStatus.modelUpdates = modelUpdates;
      }
      selectedRoutingPolicy = route.policy;
      selectedCarrier = desiredCarrier;
    } catch {
      updateStatus("installing", "draft-routing-policy-unavailable", null);
      return false;
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
      stopPolicyCapture();
      stopPolicyRecapture();
      window.removeEventListener(
        "codexhost:draft-prewarm-policy-changed",
        handleRoutingPolicyChange,
      );
      const activeRoutingPolicy = routingPolicy;
      routingPolicy = null;
      requestRouteResolver.clear();
      const cleanups = [
        () => activeRoutingPolicy?.select(null),
        () => syncActiveRoute(null),
        () => forkControl.dispose(),
        () => usageSubscription.dispose(),
      ];
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // Every owned resource must still be released if an external cleanup fails.
        }
      }
    },
  };
}
