import {
  committedReactAncestors,
  type RendererHostRoute,
  type RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHostClients } from "./renderer-host-clients.js";
import { installIdleReleasePreferenceSync } from "./renderer-idle-release-preference.js";
import {
  encodeHarnessPluginRoute,
  harnessIdSchema,
  harnessModelRefSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
  type ExternalThreadForkParams,
  type HarnessModelRef,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostThreadId,
  type ThreadCommandExecuteParams,
  type HarnessCommandsInspectParams,
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
  createThreadUsageSubscriptionRelay,
  type RendererModelClient,
} from "./renderer-model-client.js";

export const PI_TRANSPORT_MODEL_ID = "codexhost/pi-native";
export const PI_TRANSPORT_MODEL_PREFIX = `${PI_TRANSPORT_MODEL_ID}@`;
export const CLAUDE_CODE_TRANSPORT_MODEL_ID = "codexhost/claude-code-native";
export const CLAUDE_CODE_TRANSPORT_MODEL_PREFIX = `${CLAUDE_CODE_TRANSPORT_MODEL_ID}@`;
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID = "codexhost/deepseek-harness-native";
export const DEEPSEEK_HARNESS_TRANSPORT_MODEL_PREFIX = `${DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID}@`;
export const OPENCODE_TRANSPORT_MODEL_ID = "codexhost/opencode-native";
export const OPENCODE_TRANSPORT_MODEL_PREFIX = `${OPENCODE_TRANSPORT_MODEL_ID}@`;
export const GROK_TRANSPORT_MODEL_ID = "codexhost/grok-native";
export const GROK_TRANSPORT_MODEL_PREFIX = `${GROK_TRANSPORT_MODEL_ID}@`;
export const OMP_TRANSPORT_MODEL_ID = "codexhost/omp-native";
export const OMP_TRANSPORT_MODEL_PREFIX = `${OMP_TRANSPORT_MODEL_ID}@`;
export const ANTIGRAVITY_TRANSPORT_MODEL_ID = "codexhost/antigravity-native";
export const ANTIGRAVITY_TRANSPORT_MODEL_PREFIX = `${ANTIGRAVITY_TRANSPORT_MODEL_ID}@`;

/** Hermes rides the shared harness-plugin route codec instead of a private prefix. */
export const HERMES_PLUGIN_ROUTE_PREFIX = "codexhost/plugin-v1@";

export function hermesTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
): string {
  return encodeHarnessPluginRoute({
    harnessId: harnessIdSchema.parse("hermes"),
    ...(model ? { model: harnessModelRefSchema.parse(model) } : {}),
    ...(permissionModeId
      ? { permissionModeId: harnessPermissionModeIdSchema.parse(permissionModeId) }
      : {}),
  });
}

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
  __codexhostHostRoutingV1?: RendererHostRouting;
  setTimeout(handler: TimerHandler, timeout?: number): number;
}

const DRAFT_PREWARM_POLICY_WAIT_TIMEOUT_MS = 10_000;
const DRAFT_PREWARM_POLICY_POLL_INTERVAL_MS = 25;

declare global {
  interface Window {
    __codexhostMainProcessTitlePolicyV1?: { state: "ready" };
    __codexhostDraftPrewarmPolicyV1?: RendererDraftPrewarmPolicy;
    __codexhostHostRoutingV1?: RendererHostRouting;
  }
}

const KIRO_CLI_HARNESS_ID = harnessIdSchema.parse("kiro-cli");

function transportModelIdForAgent(agent: RendererAgent): string | null {
  if (agent === "pi") return PI_TRANSPORT_MODEL_ID;
  if (agent === "claude-code") return CLAUDE_CODE_TRANSPORT_MODEL_ID;
  if (agent === "deepseek-harness") return DEEPSEEK_HARNESS_TRANSPORT_MODEL_ID;
  if (agent === "opencode") return OPENCODE_TRANSPORT_MODEL_ID;
  if (agent === "grok") return GROK_TRANSPORT_MODEL_ID;
  if (agent === "omp") return OMP_TRANSPORT_MODEL_ID;
  if (agent === "antigravity") return ANTIGRAVITY_TRANSPORT_MODEL_ID;
  if (agent === "kiro-cli") return encodeHarnessPluginRoute({ harnessId: KIRO_CLI_HARNESS_ID });
  if (agent === "codebuddy" || agent === "workbuddy" || agent === "cursor-cli" || agent === "devin")
    return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse(agent) });
  if (agent === "qoder" || agent === "qoder-cn" || agent === "kimi-code") {
    return encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse(agent) });
  }
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
  permissionModeId?: HarnessPermissionModeId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OMP transport configuration requires a Model Ref");
    }
    return OMP_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedPermissionMode) {
    return `${OMP_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode}@${parsedThinking ?? ""}`;
  }
  return `${OMP_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedThinking ? `@${parsedThinking}` : ""}`;
}

export function antigravityTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("Antigravity transport configuration requires a Model Ref");
    }
    return ANTIGRAVITY_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermission = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${ANTIGRAVITY_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermission ?? ""}@${parsedThinking}`;
  }
  return `${ANTIGRAVITY_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermission ? `@${parsedPermission}` : ""}`;
}

export function openCodeTransportModelId(
  model?: HarnessModelRef,
  permissionModeId?: HarnessPermissionModeId,
  thinkingOptionId?: HarnessThinkingOptionId,
): string {
  if (!model) {
    if (permissionModeId || thinkingOptionId) {
      throw new Error("OpenCode transport configuration requires a Model Ref");
    }
    return OPENCODE_TRANSPORT_MODEL_ID;
  }
  const parsedModel = harnessModelRefSchema.parse(model);
  const parsedPermissionMode = permissionModeId
    ? harnessPermissionModeIdSchema.parse(permissionModeId)
    : undefined;
  const parsedThinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.parse(thinkingOptionId)
    : undefined;
  if (parsedThinking) {
    return `${OPENCODE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}@${parsedPermissionMode ?? ""}@${parsedThinking}`;
  }
  return `${OPENCODE_TRANSPORT_MODEL_PREFIX}${parsedModel.id}${parsedPermissionMode ? `@${parsedPermissionMode}` : ""}`;
}

export function decodeOpenCodeTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
} | null {
  if (value === OPENCODE_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OPENCODE_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(OPENCODE_TRANSPORT_MODEL_PREFIX.length).split("@");
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

export function isOpenCodeTransportModelId(value: unknown): value is string {
  return decodeOpenCodeTransportModelId(value) !== null;
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
  permissionModeId?: HarnessPermissionModeId;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  if (value === OMP_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(OMP_TRANSPORT_MODEL_PREFIX)) return null;
  const components = value.slice(OMP_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) return null;
  const [modelId, permissionOrThinkingId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionOrThinkingId) return null;
  if (components.length === 3 && !permissionOrThinkingId) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  if (!model.success) return null;
  const permissionMode =
    components.length === 3
      ? harnessPermissionModeIdSchema.safeParse(permissionOrThinkingId)
      : null;
  if (permissionMode && !permissionMode.success) return null;
  const thinking =
    components.length === 2
      ? harnessThinkingOptionIdSchema.safeParse(permissionOrThinkingId)
      : thinkingOptionId
        ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
        : null;
  if (thinking && !thinking.success) return null;
  return {
    model: model.data,
    ...(permissionMode?.success ? { permissionModeId: permissionMode.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function isOmpTransportModelId(value: unknown): value is string {
  return decodeOmpTransportModelId(value) !== null;
}

export function decodeAntigravityTransportModelId(value: unknown): {
  model?: HarnessModelRef;
  permissionModeId?: HarnessPermissionModeId;
  thinkingOptionId?: HarnessThinkingOptionId;
} | null {
  if (value === ANTIGRAVITY_TRANSPORT_MODEL_ID) return {};
  if (typeof value !== "string" || !value.startsWith(ANTIGRAVITY_TRANSPORT_MODEL_PREFIX)) {
    return null;
  }
  const components = value.slice(ANTIGRAVITY_TRANSPORT_MODEL_PREFIX.length).split("@");
  if (components.length < 1 || components.length > 3) return null;
  const [modelId, permissionModeId, thinkingOptionId] = components;
  if (components.length === 2 && !permissionModeId) return null;
  if (components.length === 3 && !thinkingOptionId) return null;
  const model = harnessModelRefSchema.safeParse({ id: modelId });
  const permission = permissionModeId
    ? harnessPermissionModeIdSchema.safeParse(permissionModeId)
    : null;
  if (!model.success || (permission && !permission.success)) return null;
  const thinking = thinkingOptionId
    ? harnessThinkingOptionIdSchema.safeParse(thinkingOptionId)
    : null;
  if (thinking && !thinking.success) return null;
  return {
    model: model.data,
    ...(permission?.success ? { permissionModeId: permission.data } : {}),
    ...(thinking?.success ? { thinkingOptionId: thinking.data } : {}),
  };
}

export function isAntigravityTransportModelId(value: unknown): value is string {
  return decodeAntigravityTransportModelId(value) !== null;
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

function requestTargetOwnerFromHookState(value: unknown): PrewarmTarget | null {
  if (!isRecord(value)) return null;
  const ownerFrom = (candidate: unknown): PrewarmTarget | null => {
    if (!isRecord(candidate)) return null;
    const requestClient = candidate.requestClient;
    const bridge = isCurrentRequestBridge(requestClient)
      ? requestClient
      : isCurrentRequestBridge(candidate)
        ? candidate
        : null;
    if (!bridge) return null;
    return typeof candidate.sendRequest === "function" ? (candidate as PrewarmTarget) : bridge;
  };
  return ownerFrom(value) ?? ownerFrom(value.manager);
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
  for (const fiber of committedReactAncestors(firstFiber)) {
    let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
    for (let hookIndex = 0; hook && hookIndex < 100; hookIndex += 1) {
      const owner = requestTargetOwnerFromHookState(hook.memoizedState);
      if (owner) targets.add(owner);
      hook =
        typeof hook.next === "object" && hook.next !== null
          ? (hook.next as { memoizedState?: unknown; next?: unknown })
          : null;
    }
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

function isLegacySevenSlotDraftWrapper(value: unknown): value is readonly unknown[] {
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

function duplicatedClientNewThreadId(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const ids = value.filter(
    (item): item is string => typeof item === "string" && item.startsWith("client-new-thread:"),
  );
  if (ids.length < 2 || ids.some((id) => id !== ids[0])) return null;
  return ids[0] ?? null;
}

function draftIdFromMemoValue(value: unknown): string | null {
  if (
    isLegacySevenSlotDraftWrapper(value) &&
    typeof value[2] === "string" &&
    value[2].startsWith("client-new-thread:")
  ) {
    return value[2];
  }
  // Codex 26.908 stores the same client-new-thread identity twice in a longer
  // memo-cache tuple (length 13/19 observed) instead of the seven-slot atom.
  return duplicatedClientNewThreadId(value);
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
      const draftId = draftIdFromMemoValue(value);
      if (draftId) draftIds.add(draftId);
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

export async function waitForRendererDraftPrewarmPolicy(
  target: RendererDraftPrewarmPolicyTarget,
  composer?: Element,
): Promise<RendererDraftPrewarmPolicy> {
  const deadline = Date.now() + DRAFT_PREWARM_POLICY_WAIT_TIMEOUT_MS;
  while (true) {
    const policy = target.__codexhostHostRoutingV1?.forComposer(composer)?.policy;
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
          : agent === "opencode"
            ? openCodeTransportModelId(model, permissionModeId, thinkingOptionId)
            : agent === "grok"
              ? grokTransportModelId(model, permissionModeId, thinkingOptionId)
              : agent === "omp"
                ? ompTransportModelId(model, thinkingOptionId, permissionModeId)
                : agent === "antigravity"
                  ? antigravityTransportModelId(model, permissionModeId, thinkingOptionId)
                  : agent === "kiro-cli" ||
                      agent === "codebuddy" ||
                      agent === "workbuddy" ||
                      agent === "cursor-cli" ||
                      agent === "devin"
                    ? encodeHarnessPluginRoute({
                        harnessId: harnessIdSchema.parse(agent),
                        ...(model ? { model } : {}),
                        ...(thinkingOptionId && agent !== "cursor-cli" && agent !== "devin"
                          ? { thinkingOptionId }
                          : {}),
                        ...(permissionModeId ? { permissionModeId } : {}),
                      })
                    : agent === "hermes"
                      ? hermesTransportModelId(model, permissionModeId)
                      : agent === "qoder" || agent === "qoder-cn" || agent === "kimi-code"
                        ? encodeHarnessPluginRoute({
                            harnessId: harnessIdSchema.parse(agent),
                            ...(model ? { model } : {}),
                            ...(thinkingOptionId ? { thinkingOptionId } : {}),
                            ...(permissionModeId ? { permissionModeId } : {}),
                          })
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

  const usageSubscription = createThreadUsageSubscriptionRelay();
  const idleReleaseSync = installIdleReleasePreferenceSync(window);
  const clients = createRendererHostClients(() => window.__codexhostHostRoutingV1);
  const currentRequestRoute = (): RendererHostRoute | null => {
    const route = disposed ? null : (window.__codexhostHostRoutingV1?.forComposer() ?? null);
    usageSubscription.connect(clients.forRoute(route));
    idleReleaseSync.connect(disposed ? null : clients.forHost("local"));
    updateStatus(
      route ? "ready" : "installing",
      route ? "ready" : "draft-routing-policy-unavailable",
      route ? "request-bridge" : null,
    );
    return route;
  };
  const currentModelClient = (): RendererModelClient => {
    const client = clients.forRoute(currentRequestRoute());
    if (!client) throw new Error("Renderer Model request manager is unavailable");
    return client;
  };
  const modelControl: RendererModelClient = Object.freeze({
    currentHostId: () => {
      currentRequestRoute();
      return disposed ? null : (window.__codexhostHostRoutingV1?.hostIdForComposer() ?? null);
    },
    clientForHost: (hostId: string) => (disposed ? null : clients.forHost(hostId)),
    listHarnessPlugins: async () => {
      const client = currentModelClient();
      if (!client.listHarnessPlugins) throw new Error("Harness plugin directory is unavailable");
      return client.listHarnessPlugins();
    },
    forkThread: (input: ExternalThreadForkParams) => currentModelClient().forkThread(input),
    inspectHarness: (...args: Parameters<RendererModelClient["inspectHarness"]>) =>
      currentModelClient().inspectHarness(...args),
    inspectThread: (input: ThreadInspectionParams) => currentModelClient().inspectThread(input),
    inspectHarnessCommands: (input: HarnessCommandsInspectParams) =>
      currentModelClient().inspectHarnessCommands(input),
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
    inspectCodexAccountUsage: (
      input: Parameters<NonNullable<RendererModelClient["inspectCodexAccountUsage"]>>[0],
    ) => {
      const client = currentModelClient();
      if (!client.inspectCodexAccountUsage) throw new Error("Codex Account Usage is unavailable");
      return client.inspectCodexAccountUsage(input);
    },
    listHarnessAccountSources: () => {
      const client = currentModelClient();
      if (!client.listHarnessAccountSources) {
        throw new Error("Harness account source discovery is unavailable");
      }
      return client.listHarnessAccountSources();
    },
    inspectHarnessAccount: (
      input: Parameters<NonNullable<RendererModelClient["inspectHarnessAccount"]>>[0],
    ) => {
      const client = currentModelClient();
      if (!client.inspectHarnessAccount) {
        throw new Error("Harness account inspection is unavailable");
      }
      return client.inspectHarnessAccount(input);
    },
    listHarnessAccounts: (
      input?: Parameters<NonNullable<RendererModelClient["listHarnessAccounts"]>>[0],
    ) => {
      const client = currentModelClient();
      if (!client.listHarnessAccounts) throw new Error("Harness account inspection is unavailable");
      return client.listHarnessAccounts(input);
    },
    credentialImports: (
      request: Parameters<NonNullable<RendererModelClient["credentialImports"]>>[0],
      targetHarnessId?: string,
    ) => {
      const client = currentModelClient();
      if (!client.credentialImports) throw new Error("Credential imports are unavailable");
      return client.credentialImports(request, targetHarnessId);
    },
    listCodexAccounts: () => currentModelClient().listCodexAccounts(),
    refreshCodexAccounts: () => {
      const client = currentModelClient();
      return client.refreshCodexAccounts?.() ?? client.listCodexAccounts();
    },
    subscribeCodexAccounts: (
      listener: Parameters<NonNullable<RendererModelClient["subscribeCodexAccounts"]>>[0],
    ) => {
      const client = currentModelClient();
      if (!client.subscribeCodexAccounts) throw new Error("Codex Account updates are unavailable");
      return client.subscribeCodexAccounts(listener);
    },
  });
  const forkControl = installRendererForkControl({
    getClient: () => modelControl,
    reportError: (error) => {
      console.error(
        "codexhost external Thread Fork failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  });

  const selectedPolicies = new Map<string, RendererDraftPrewarmPolicy>();
  const handleRoutingPolicyChange = (): void => {
    currentRequestRoute();
  };
  window.addEventListener("codexhost:draft-prewarm-policy-changed", handleRoutingPolicyChange);
  currentRequestRoute();

  const applyAgent = (
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
    composer?: Element,
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
    const route = window.__codexhostHostRoutingV1?.forComposer(composer);
    if (!route) return false;
    try {
      if (route.policy.select(carrier ?? null)) {
        modelUpdates += 1;
        liveStatus.modelUpdates = modelUpdates;
      }
      selectedPolicies.set(route.hostId, route.policy);
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
      window.removeEventListener(
        "codexhost:draft-prewarm-policy-changed",
        handleRoutingPolicyChange,
      );
      const cleanups = [
        ...[...selectedPolicies.values()].map((policy) => () => policy.select(null)),
        () => forkControl.dispose(),
        () => clients.dispose(),
        () => usageSubscription.dispose(),
        () => idleReleaseSync.dispose(),
      ];
      selectedPolicies.clear();
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
