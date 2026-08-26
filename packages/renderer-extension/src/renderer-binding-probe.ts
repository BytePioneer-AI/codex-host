import {
  harnessIdSchema,
  type HarnessCommandDescriptor,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type AccountCreditsSnapshot,
  type ThreadInspection,
  type ThreadUsageInspection,
  type ThreadUsageSnapshot,
  type CodexhostError,
} from "@codexhost/shared-contracts";

import {
  DEFAULT_RENDERER_AGENTS,
  DraftAgentController,
  type ComposerAgentPhase,
  type ExternalRendererAgent,
  type RendererAgent,
  type RendererAgentAvailability,
} from "./agent-selection-state.js";
import {
  CODEX_COMPOSER_SELECTOR,
  EDITOR_SELECTOR,
  composerForEditor,
  composerForElement,
  disposeComposerAgentControl,
  editorForElement,
  eventElement,
  isComposerInputIntent,
  isComposerSubmissionKey,
  mountComposerAgentControl,
  reconcileComposerNativeControls,
  renderComposerAgentControl,
  sendButtonWithin,
  type ComposerAgentControl,
  type ExternalModelControlView,
  type ExternalPermissionModeControlView,
} from "./renderer-composer-dom.js";
import {
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodePiTransportModelId,
  findComposerModelTarget,
  threadIdFromComposerModelTarget,
  waitForRendererDraftPrewarmPolicy,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { RENDERER_AGENT_INSTALL_URLS } from "./renderer-agent-picker.js";
import {
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
} from "./renderer-permission-mode-preference.js";
import { isPermissionModeControlReady } from "./renderer-permission-mode-picker.js";
import {
  readNewThreadAgentPreference,
  readNewThreadExternalConfigurationPreference,
  writeNewThreadAgentPreference,
  writeNewThreadExternalConfigurationPreference,
} from "./renderer-new-thread-preference.js";
import { installRendererSidebarAgentIcons } from "./renderer-sidebar-agent-icons.js";
import { installRendererSettingsLifecycle } from "./renderer-settings-lifecycle.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "./settings/pages.js";
import {
  startCompatibilityUpdate,
  type CompatibilityUpdateOutcome,
} from "./compatibility-update.js";

const externalHarnessIds = {
  pi: harnessIdSchema.parse("pi"),
  "claude-code": harnessIdSchema.parse("claude-code"),
  "deepseek-harness": harnessIdSchema.parse("deepseek-harness"),
  grok: harnessIdSchema.parse("grok"),
} as const;

const externalAgents: readonly ExternalRendererAgent[] = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
];
type HarnessAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;
type HarnessAvailabilityErrors = Record<ExternalRendererAgent, CodexhostError | undefined>;

function isRetryableHarnessAvailability(
  availability: RendererAgentAvailability | undefined,
  error: CodexhostError | undefined,
): boolean {
  return (
    availability !== undefined &&
    availability !== "ready" &&
    availability !== "notInstalled" &&
    error?.retryable === true
  );
}

export function retryableHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
): ExternalRendererAgent[] {
  return externalAgents.filter((agent) =>
    isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

export function passiveHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
): ExternalRendererAgent[] {
  return externalAgents.filter(
    (agent) =>
      availability[agent] === "checking" ||
      isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

interface HostHarnessAvailabilityState {
  availability: HarnessAvailability;
  errors: HarnessAvailabilityErrors;
  requestGeneration: number;
  request: { client: RendererModelClient; promise: Promise<void> } | null;
  retryTimer: number | null;
  retryAttempt: number;
}

const rendererUsageRefreshDelays = [250, 500, 1000, 2000, 4000, 8000] as const;

export function rendererUsageRefreshDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt), rendererUsageRefreshDelays.length - 1));
  return rendererUsageRefreshDelays[index] ?? rendererUsageRefreshDelays[0];
}

/**
 * Agents whose Harness Adapter implements `credits()`/`refreshCredits()` — the only ones where
 * it's worth retrying purely to pick up Account Credits after Usage has already arrived. Every
 * other Agent would retry forever at the backoff ceiling for a value it can never produce.
 */
function externalAgentHasAccountCredits(agent: RendererAgent): boolean {
  return agent === "grok" || agent === "claude-code";
}

export function shouldRetryExternalThreadUsage(
  agent: RendererAgent,
  usage: ThreadUsageSnapshot | null,
  accountCredits: AccountCreditsSnapshot | null = null,
): boolean {
  if (agent === "codex") return false;
  if (usage === null) return true;
  return externalAgentHasAccountCredits(agent) && accountCredits === null;
}

export function shouldReloadExternalCatalogAfterAvailabilityRefresh(
  previous: RendererAgentAvailability | undefined,
  next: RendererAgentAvailability,
  configurationReady: boolean,
): boolean {
  return previous !== next || !configurationReady;
}

export interface RendererBindingProbeStatus {
  version: 2;
  mountedComposers: number;
  enabledAgents: RendererAgent[];
  availability: HarnessAvailability;
  selections: Array<{
    composerId: string;
    agent: RendererAgent;
    phase: ComposerAgentPhase;
  }>;
  adapter: RendererAdapterStatus;
}

export interface RendererBindingProbeOptions {
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

type ApplyAdapterAgent = (
  agent: RendererAgent,
  model?: HarnessModelRef,
  thinkingOptionId?: HarnessThinkingOptionId,
  permissionModeId?: HarnessPermissionModeId,
  composer?: Element,
) => boolean;

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  requestCompatibilityUpdate(): Promise<CompatibilityUpdateOutcome>;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: ApplyAdapterAgent,
    modelControl?: RendererModelClient | null,
  ): void;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostRendererBindingProbeV1?: RendererBindingProbeApi;
  }
}

export type ComposerOwnershipStatus = "not-required" | "loading" | "ready" | "error";

export interface RestoredThreadOwnership {
  agent: RendererAgent;
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}

function selectableThinkingOptionId(
  state: HarnessModelSelectionState,
): HarnessThinkingOptionId | undefined {
  return state.effectiveThinkingOptionId &&
    state.availableThinkingOptions?.some(({ id }) => id === state.effectiveThinkingOptionId)
    ? state.effectiveThinkingOptionId
    : undefined;
}

export function draftThinkingOptionForModel(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  requested: HarnessThinkingOptionId | undefined,
): HarnessThinkingOptionId | undefined {
  const options = thinkingOptionsForModel(catalog, model);
  return (
    options.find(({ id }) => id === requested)?.id ??
    options.find(({ id }) => id === catalog.defaultThinkingOptionId)?.id ??
    options[0]?.id
  );
}

export function draftPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  requested: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId {
  return (
    catalog.modes.find(({ id }) => id === requested)?.id ??
    catalog.modes.find(({ id }) => id === catalog.defaultModeId)?.id ??
    catalog.defaultModeId
  );
}

export function shouldPersistNewThreadConfigurationSelection(phase: ComposerAgentPhase): boolean {
  return phase === "draft";
}

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  if (inspection.harnessId === "pi") {
    const transportSelection = decodePiTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Pi Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    return {
      agent: "pi",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(inspection.effectivePermissionModeId
        ? { permissionModeId: inspection.effectivePermissionModeId }
        : {}),
    };
  }
  if (inspection.harnessId === "grok") {
    const transportSelection = decodeGrokTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Grok Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "grok",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "claude-code") {
    const transportSelection = decodeClaudeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Claude Code Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "claude-code",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "deepseek-harness") {
    const transportSelection = decodeDeepSeekHarnessTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("DeepSeek Harness Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    return { agent: "deepseek-harness", ...(model ? { model } : {}) };
  }
  throw new Error("Thread owner is not a Renderer Agent");
}

export function isOwnershipSubmissionBlocked(status: ComposerOwnershipStatus): boolean {
  return status === "loading" || status === "error";
}

interface MountedComposer {
  composer: Element;
  composerId: string;
  control: ComposerAgentControl;
  modelTarget: readonly unknown[] | null;
  modelView: ExternalModelControlView;
  permissionModeView: ExternalPermissionModeControlView;
  ownershipStatus: ComposerOwnershipStatus;
  threadConfiguration: HarnessModelSelectionState | undefined;
  usage: ThreadUsageSnapshot | null;
  accountCredits: AccountCreditsSnapshot | null;
  hostId: string | null;
  usageRequestGeneration: number;
}

interface PendingComposerReplacement {
  source: MountedComposer;
  sourceModelTarget: readonly unknown[] | null;
}

type SubmissionTrigger = "click" | "enter" | "submit";

export function shouldTransferComposerState(
  sourceTarget: readonly unknown[] | null,
  replacementTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): boolean {
  if (!sourceTarget || !replacementTarget) return false;
  if (sourceTarget === replacementTarget) return true;
  return (
    (sourcePhase === "locked" || submissionPending) &&
    sourceTarget[0] === "default" &&
    replacementTarget[0] === "conversation"
  );
}

export function isLateConversationTarget(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
): boolean {
  if (currentTarget?.[0] !== "conversation") return false;
  if (mountedTarget === null) return true;
  if (mountedTarget?.[0] === "default") return true;
  if (mountedTarget?.[0] !== "conversation") return false;
  return (
    mountedTarget.length !== currentTarget.length ||
    mountedTarget.some((value, index) => value !== currentTarget[index])
  );
}

export function lateConversationTargetResolution(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
  sourcePhase: ComposerAgentPhase,
  submissionPending = false,
): "none" | "transfer" | "inspect" {
  if (!isLateConversationTarget(mountedTarget, currentTarget)) return "none";
  return mountedTarget?.[0] === "default" && (sourcePhase === "locked" || submissionPending)
    ? "transfer"
    : "inspect";
}

export function scopedComposerTarget(
  target: readonly unknown[] | null,
  hostId: string | null,
): readonly unknown[] | null {
  if (target?.[0] !== "conversation" || !hostId) return target;
  return ["conversation", target[1], hostId];
}

export function isComposerModelWriteAllowed(target: readonly unknown[] | null): boolean {
  return target?.[0] === "default";
}

export function shouldApplyDraftAgentCarrier(
  agent: RendererAgent,
  model: HarnessModelRef | undefined,
): boolean {
  return agent === "codex" || model !== undefined;
}

export function applyComposerModelWrite(
  target: readonly unknown[] | null,
  write: () => boolean,
): boolean {
  if (target?.[0] === "conversation") return true;
  if (!isComposerModelWriteAllowed(target)) return false;
  return write();
}

function mutationMayChangeComposerTarget(mutation: MutationRecord): boolean {
  const target =
    mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  return !target || editorForElement(target) === null;
}

function catalogWithConfigurationState(
  catalog: HarnessModelCatalog,
  model: HarnessModelRef,
  state: HarnessModelSelectionState,
): HarnessModelCatalog {
  if (!state.availableThinkingOptions) return catalog;
  const supportedThinkingOptionIds = state.availableThinkingOptions.map(({ id }) => id);
  const models = catalog.models.map((candidate) => {
    const normalized = { ...candidate };
    delete normalized.supportedThinkingOptionIds;
    return candidate.ref.id === model.id
      ? { ...normalized, supportedThinkingOptionIds }
      : normalized;
  });
  const normalized = {
    ...catalog,
    models,
    defaultModel: model,
    thinkingOptions: state.availableThinkingOptions,
  };
  if (state.effectiveThinkingOptionId) {
    normalized.defaultThinkingOptionId = state.effectiveThinkingOptionId;
  } else {
    delete normalized.defaultThinkingOptionId;
  }
  return normalized;
}

export function installRendererBindingProbe(
  options: RendererBindingProbeOptions = {},
): RendererBindingProbeApi {
  const existing = window.__codexhostRendererBindingProbeV1;
  if (existing) return existing;

  const enabledAgents = [...new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS)];
  const enabledAgentSet = new Set(enabledAgents);
  const controller = new DraftAgentController<Element>({
    enabledAgents,
    ...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
  });
  const mountedByComposer = new Map<Element, MountedComposer>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  let disposed = false;
  let scanScheduled = false;
  let refreshTargetsOnNextScan = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ApplyAdapterAgent | null = null;
  let modelControl: RendererModelClient | null = null;
  const activeModelHostId = (): string | null => {
    if (!modelControl) return null;
    return modelControl.currentHostId ? modelControl.currentHostId() : "local";
  };
  const controllerTarget = (target: readonly unknown[] | null, hostId: string | null) =>
    scopedComposerTarget(target, hostId);
  let usageNotificationDispose: (() => void) | null = null;
  const localAgentForSidebarThread = (input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null => {
    const mountedHostId = modelControl?.currentHostId?.() ?? "local";
    if (input.hostId !== mountedHostId) return null;
    for (const mounted of mountedByComposer.values()) {
      const target = mounted.modelTarget;
      if (target?.[0] === "default" && input.draftId !== null && target[1] === input.draftId) {
        return controller.get(mounted.composer).agent;
      }
      if (
        target?.[0] === "conversation" &&
        input.threadId !== null &&
        target[1] === input.threadId &&
        mounted.ownershipStatus === "ready"
      ) {
        return controller.get(mounted.composer).agent;
      }
    }
    return null;
  };
  const sidebarAgentIcons = installRendererSidebarAgentIcons({
    getClient: (hostId) => modelClientForHost(hostId),
    getLocalAgent: localAgentForSidebarThread,
  });
  let connectionDiagnostics: RendererConnectionDiagnostics | null = null;
  const settingsLifecycle = installRendererSettingsLifecycle(window, {
    getUpdateClient: () => modelControl,
    getConnectionDiagnostics: () => connectionDiagnostics,
  });
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };
  const createHostHarnessAvailabilityState = (): HostHarnessAvailabilityState => ({
    availability: Object.fromEntries(
      externalAgents.map((agent) => [agent, "checking"]),
    ) as HarnessAvailability,
    errors: {
      pi: undefined,
      "claude-code": undefined,
      "deepseek-harness": undefined,
      grok: undefined,
    },
    requestGeneration: 0,
    request: null,
    retryTimer: null,
    retryAttempt: 0,
  });
  const harnessAvailabilityByHost = new Map<string, HostHarnessAvailabilityState>();
  const hostHarnessAvailabilityState = (hostId: string): HostHarnessAvailabilityState => {
    let state = harnessAvailabilityByHost.get(hostId);
    if (!state) {
      state = createHostHarnessAvailabilityState();
      harnessAvailabilityByHost.set(hostId, state);
    }
    return state;
  };
  let activeAvailabilityHostId = "local";
  const activeHarnessAvailabilityState = (): HostHarnessAvailabilityState =>
    hostHarnessAvailabilityState(activeAvailabilityHostId);
  const connectionListeners = new Set<() => void>();
  const publishConnectionStatus = (): void => {
    for (const listener of connectionListeners) listener();
  };
  const availabilityRetryDelays = [500, 1000, 2000, 4000, 8000] as const;
  const usageRefreshTimers = new Map<Element, number>();
  const usageRefreshAttempts = new Map<Element, number>();

  const isMountedComposer = (composer: Element): boolean =>
    composer.isConnected &&
    composer.matches(CODEX_COMPOSER_SELECTOR) &&
    mountedByComposer.has(composer);

  const isCurrentModelRequest = (mounted: MountedComposer, generation: number): boolean =>
    isMountedComposer(mounted.composer) &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentModelRequest(mounted.composer, generation);

  const isCurrentOwnershipRequest = (mounted: MountedComposer, generation: number): boolean =>
    mounted.composer.isConnected &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentOwnershipRequest(mounted.composer, generation);

  const notifySubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const state = controller.recordSubmission(composer);
    writeNewThreadAgentPreference(state.agent);
    if (state.agent !== "codex") {
      const model = controller.modelForAgent(composer, state.agent);
      if (model) {
        writeNewThreadExternalConfigurationPreference(
          state.agent,
          model,
          controller.thinkingOptionForAgent(composer, state.agent),
          controller.permissionModeForAgent(composer, state.agent),
        );
      }
    }
    window.dispatchEvent(
      new CustomEvent("codexhost:renderer-submission", {
        detail: {
          composerId: state.composerId,
          agent: state.agent,
          trigger,
        },
      }),
    );
  };

  const renderMounted = (mounted: MountedComposer): void => {
    renderComposerAgentControl(
      mounted.control,
      controller.get(mounted.composer),
      adapterStatus.state,
      controller.isSwitching(mounted.composer) ||
        isOwnershipSubmissionBlocked(mounted.ownershipStatus),
      activeHarnessAvailabilityState().availability,
      mounted.modelView,
      mounted.permissionModeView,
      controller.get(mounted.composer).agent === "codex" ? null : mounted.usage,
      mounted.accountCredits,
    );
  };

  const refreshCommands = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (state.agent === "codex" || !threadId || !modelControl) {
      mounted.control.harnessCommands.setCommands([]);
      return;
    }
    try {
      const catalog = await modelControl.inspectThreadCommands({ threadId });
      if (
        disposed ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        controller.get(mounted.composer).agent === "codex"
      ) {
        return;
      }
      mounted.control.harnessCommands.setCommands(catalog.commands);
    } catch {
      if (mountedByComposer.get(mounted.composer) === mounted) {
        mounted.control.harnessCommands.setCommands([]);
      }
    }
  };

  const executeCommand = async (
    mounted: MountedComposer,
    command: HarnessCommandDescriptor,
  ): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId || !modelControl || controller.get(mounted.composer).agent === "codex") return;
    mounted.control.harnessCommands.setExecuting(command.id);
    try {
      await modelControl.executeThreadCommand({ threadId, commandId: command.id });
    } catch (error) {
      console.error(
        "codexhost Harness command failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      mounted.control.harnessCommands.setExecuting(null);
    }
  };

  const applyThreadUsageUpdate = (update: ThreadUsageInspection): void => {
    for (const mounted of mountedByComposer.values()) {
      if (threadIdFromComposerModelTarget(mounted.modelTarget) !== update.threadId) continue;
      mounted.usageRequestGeneration += 1;
      mounted.usage = update.usage;
      mounted.accountCredits = update.accountCredits ?? null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
    }
  };

  const refreshThreadUsage = async (mounted: MountedComposer): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId || !modelControl) {
      mounted.usage = null;
      mounted.accountCredits = null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
      return;
    }
    const generation = ++mounted.usageRequestGeneration;
    try {
      const result = await modelControl.inspectThreadUsage({ threadId });
      if (
        disposed ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        !mounted.composer.isConnected ||
        mounted.usageRequestGeneration !== generation ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        result.threadId !== threadId
      ) {
        return;
      }
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      const agent = controller.get(mounted.composer).agent;
      if (
        result.usage !== null &&
        (!externalAgentHasAccountCredits(agent) || result.accountCredits)
      ) {
        usageRefreshAttempts.delete(mounted.composer);
      }
      renderMounted(mounted);
      if (
        shouldRetryExternalThreadUsage(
          controller.get(mounted.composer).agent,
          result.usage,
          result.accountCredits ?? null,
        )
      ) {
        scheduleThreadUsageRefresh(mounted);
      }
    } catch {
      if (
        mountedByComposer.get(mounted.composer) === mounted &&
        mounted.usageRequestGeneration === generation
      ) {
        renderMounted(mounted);
        if (shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)) {
          scheduleThreadUsageRefresh(mounted);
        }
      }
    }
  };

  const scheduleThreadUsageRefresh = (mounted: MountedComposer): void => {
    if (usageRefreshTimers.has(mounted.composer)) return;
    const attempt = usageRefreshAttempts.get(mounted.composer) ?? 0;
    usageRefreshAttempts.set(mounted.composer, attempt + 1);
    const timer = window.setTimeout(() => {
      usageRefreshTimers.delete(mounted.composer);
      void refreshThreadUsage(mounted);
    }, rendererUsageRefreshDelay(attempt));
    usageRefreshTimers.set(mounted.composer, timer);
  };

  const isExternalConfigurationReady = (mounted: MountedComposer): boolean => {
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return true;
    return (
      mounted.modelView.status !== "selecting" &&
      mounted.modelView.catalog?.models.some(
        (model) => model.ref.id === mounted.modelView.selected?.id,
      ) === true &&
      isPermissionModeControlReady(mounted.permissionModeView)
    );
  };

  const clearDraftPrewarm = async (): Promise<void> => {
    const policy = await waitForRendererDraftPrewarmPolicy(window);
    await policy.clear();
  };

  const applyExternalConfiguration = (
    mounted: MountedComposer,
    agent: Exclude<RendererAgent, "codex">,
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): boolean => {
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(agent, model, thinkingOptionId, permissionModeId, mounted.composer) ??
        false,
    );
  };

  const loadThreadOwnership = async (mounted: MountedComposer): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId) {
      mounted.ownershipStatus = "not-required";
      return;
    }
    const requestModelControl = modelControl;
    const requestHostId = activeModelHostId();
    const client =
      requestModelControl && requestHostId
        ? (requestModelControl.clientForHost?.(requestHostId) ?? requestModelControl)
        : null;
    const generation = controller.beginOwnershipRequest(mounted.composer);
    const usageGeneration = mounted.usageRequestGeneration;
    mounted.ownershipStatus = "loading";
    renderMounted(mounted);
    try {
      if (!client || !requestHostId) throw new Error("Thread ownership control is unavailable");
      mounted.hostId = requestHostId;
      const inspection = await client.inspectThread({ threadId });
      if (
        !isCurrentOwnershipRequest(mounted, generation) ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        activeModelHostId() !== requestHostId
      ) {
        return;
      }
      const { agent, model, thinkingOptionId, permissionModeId } =
        restoredThreadOwnership(inspection);
      if (mounted.usageRequestGeneration === usageGeneration) {
        mounted.usage = inspection.owner === "external" ? (inspection.usage ?? null) : null;
      }
      const restored = controller.restore(
        mounted.composer,
        agent,
        model,
        thinkingOptionId,
        permissionModeId,
      );
      if (!restored) {
        throw new Error("Thread owner could not be applied to the Composer");
      }
      mounted.ownershipStatus = "ready";
      if (agent !== "codex") {
        if (inspection.owner !== "external") {
          throw new Error("External Thread inspection did not include configuration");
        }
        mounted.threadConfiguration = {
          ...(inspection.effectiveModel ? { effectiveModel: inspection.effectiveModel } : {}),
          ...(inspection.resolvedModelLabel
            ? { resolvedModelLabel: inspection.resolvedModelLabel }
            : {}),
          ...(inspection.effectiveThinkingOptionId
            ? { effectiveThinkingOptionId: inspection.effectiveThinkingOptionId }
            : {}),
          ...(inspection.availableThinkingOptions
            ? { availableThinkingOptions: inspection.availableThinkingOptions }
            : {}),
          ...(inspection.effectivePermissionModeId
            ? { effectivePermissionModeId: inspection.effectivePermissionModeId }
            : {}),
        };
        mounted.modelView = { status: "loading" };
        mounted.permissionModeView = { status: "loading" };
        void loadExternalCatalog(mounted);
      } else {
        mounted.threadConfiguration = undefined;
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
      }
    } catch {
      if (!isCurrentOwnershipRequest(mounted, generation)) return;
      mounted.ownershipStatus = "error";
    } finally {
      if (isCurrentOwnershipRequest(mounted, generation)) {
        renderMounted(mounted);
        if (mounted.ownershipStatus !== "error") void refreshCommands(mounted);
        sidebarAgentIcons.refresh();
        if (mounted.ownershipStatus !== "error") {
          const agent = controller.get(mounted.composer).agent;
          if (agent === "codex" && mounted.usage === null) {
            void refreshThreadUsage(mounted);
          } else if (shouldRetryExternalThreadUsage(agent, mounted.usage, mounted.accountCredits)) {
            scheduleThreadUsageRefresh(mounted);
          }
        }
      }
    }
  };

  const refreshMountedConversationTarget = (mounted: MountedComposer): boolean => {
    const currentTarget = findComposerModelTarget(mounted.composer);
    const resolution = lateConversationTargetResolution(
      mounted.modelTarget,
      currentTarget,
      controller.get(mounted.composer).phase,
      controller.isSubmissionPending(mounted.composer),
    );
    if (resolution === "none") return false;

    const previousTarget = mounted.modelTarget;
    const nextHostId = activeModelHostId() ?? mounted.hostId;
    const nextControllerTarget = controllerTarget(currentTarget, nextHostId);
    mounted.modelTarget = currentTarget;
    mounted.hostId = nextHostId;
    const rebound =
      resolution === "transfer"
        ? controller.transfer(mounted.composer, mounted.composer, nextControllerTarget)
        : controller.rebindConversation(mounted.composer, nextControllerTarget) !== null;
    if (!rebound) {
      mounted.ownershipStatus = "error";
      renderMounted(mounted);
      return true;
    }
    if (resolution === "transfer") {
      mounted.ownershipStatus = "ready";
      renderMounted(mounted);
      if (shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)) {
        scheduleThreadUsageRefresh(mounted);
      }
    } else {
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      if (previousTarget?.[0] === "conversation") renderMounted(mounted);
      void loadThreadOwnership(mounted);
    }
    sidebarAgentIcons.refresh();
    return true;
  };

  const loadExternalCatalog = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
    const availability = activeHarnessAvailabilityState().availability[agent];
    if (availability !== "ready") {
      mounted.modelView = {
        status:
          adapterStatus.state !== "ready" || availability === "checking"
            ? "waitingForAdapter"
            : "error",
        thinkingSelectionSupported: false,
        ...(availability && availability !== "checking"
          ? { error: `${agent} runtime is ${availability}` }
          : {}),
      };
      mounted.permissionModeView = { status: "idle" };
      renderMounted(mounted);
      if (availability === "checking") void refreshHarnessAvailability();
      return;
    }
    mounted.modelView = {
      status: adapterStatus.state === "ready" ? "loading" : "waitingForAdapter",
      thinkingSelectionSupported: false,
    };
    mounted.permissionModeView = { status: "idle" };
    renderMounted(mounted);
    if (adapterStatus.state !== "ready") return;
    const generation = controller.beginModelRequest(mounted.composer);
    try {
      if (!modelControl) throw new Error("External configuration control is unavailable");
      const inspection = await modelControl.inspectHarness({
        harnessId: externalHarnessIds[agent],
      });
      if (
        !isCurrentModelRequest(mounted, generation) ||
        controller.get(mounted.composer).agent !== agent
      ) {
        return;
      }
      if (inspection.status !== "ready") throw new Error(inspection.error.message);
      const current = controller.get(mounted.composer);
      const previousModel = controller.modelForAgent(mounted.composer, agent);
      const previousModelAvailable =
        previousModel !== undefined &&
        inspection.catalog.models.some((model) => model.ref.id === previousModel.id);
      if (current.phase === "locked" && previousModel && !previousModelAvailable) {
        throw new Error("Existing Thread Model is absent from the current Catalog");
      }
      const preferredConfiguration =
        current.phase === "draft" && !previousModelAvailable
          ? readNewThreadExternalConfigurationPreference(
              agent,
              inspection.catalog,
              inspection.permissionModes,
            )
          : undefined;
      const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      let selectedPermissionModeId: HarnessPermissionModeId | undefined;
      if (inspection.capabilities.configuration.selectPermissionMode) {
        const permissionModes = inspection.permissionModes;
        if (!permissionModes) {
          throw new Error("External Harness omitted its Permission Mode catalog");
        }
        mounted.permissionModeView = { status: "loading", catalog: permissionModes };
        const effectivePermissionModeId =
          current.phase === "locked"
            ? mounted.threadConfiguration?.effectivePermissionModeId
            : undefined;
        const preferredPermissionModeId =
          preferredConfiguration?.permissionModeId ??
          (agent === "claude-code"
            ? readClaudePermissionModePreference(permissionModes)
            : undefined);
        selectedPermissionModeId = draftPermissionMode(
          permissionModes,
          effectivePermissionModeId ?? previousPermissionModeId ?? preferredPermissionModeId,
        );
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          selected: selectedPermissionModeId,
        };
      } else {
        mounted.permissionModeView = { status: "unsupported" };
      }

      if (
        !inspection.capabilities.configuration.selectModel ||
        inspection.catalog.models.length === 0
      ) {
        mounted.modelView = {
          status: "empty",
          catalog: inspection.catalog,
          thinkingSelectionSupported: false,
        };
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
          };
        }
        return;
      }

      const selected = previousModelAvailable
        ? previousModel
        : (preferredConfiguration?.model ?? inspection.catalog.defaultModel);
      if (!selected) throw new Error("External Harness did not report its default Model");
      const effectiveCatalog =
        current.phase === "locked" && mounted.threadConfiguration
          ? catalogWithConfigurationState(inspection.catalog, selected, mounted.threadConfiguration)
          : inspection.catalog;
      const previousThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const requestedThinkingOptionId = previousModelAvailable
        ? previousThinkingOptionId
        : preferredConfiguration?.thinkingOptionId;
      const selectedThinkingOptionId = inspection.capabilities.configuration.selectThinkingOption
        ? draftThinkingOptionForModel(effectiveCatalog, selected, requestedThinkingOptionId)
        : undefined;
      if (
        current.phase === "draft" &&
        (previousModel?.id !== selected.id ||
          previousThinkingOptionId !== selectedThinkingOptionId ||
          previousPermissionModeId !== selectedPermissionModeId)
      ) {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            selected,
            selectedThinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("External configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyAdapterAgent?.(
              agent,
              previousModel,
              previousThinkingOptionId,
              previousPermissionModeId,
              mounted.composer,
            );
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      }
      controller.setExternalModel(mounted.composer, agent, selected);
      controller.setExternalThinkingOption(mounted.composer, agent, selectedThinkingOptionId);
      if (selectedPermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, selectedPermissionModeId);
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected,
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        ...(mounted.threadConfiguration?.resolvedModelLabel
          ? { resolvedModelLabel: mounted.threadConfiguration.resolvedModelLabel }
          : {}),
        thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
      };
      if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
        mounted.permissionModeView = {
          status: "ready",
          catalog: mounted.permissionModeView.catalog,
          selected: selectedPermissionModeId,
        };
      }
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      const selected = controller.modelForAgent(mounted.composer, agent);
      const selectedThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const selectedPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const message = error instanceof Error ? error.message : String(error);
      mounted.modelView = {
        status: "error",
        ...(mounted.modelView.catalog ? { catalog: mounted.modelView.catalog } : {}),
        ...(selected ? { selected } : {}),
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        thinkingSelectionSupported: false,
        error: message,
      };
      if (
        mounted.permissionModeView.status !== "unsupported" &&
        mounted.permissionModeView.status !== "idle"
      ) {
        mounted.permissionModeView = {
          status: "error",
          ...(mounted.permissionModeView.catalog
            ? { catalog: mounted.permissionModeView.catalog }
            : {}),
          ...(selectedPermissionModeId ? { selected: selectedPermissionModeId } : {}),
          error: message,
        };
      }
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectExternalModel = async (mounted: MountedComposer, modelId: string): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const selected = catalog?.models.find((model) => model.ref.id === modelId)?.ref;
    if (!catalog || !selected || !modelControl) return;
    const previousModel = controller.modelForAgent(mounted.composer, agent);
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const supportsThinkingSelection = mounted.modelView.thinkingSelectionSupported === true;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: previousModel ?? selected,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: supportsThinkingSelection,
    };
    renderMounted(mounted);
    try {
      let effectiveModel: HarnessModelRef;
      let effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
      let effectiveCatalog: HarnessModelCatalog;
      let resolvedModelLabel: string | undefined;
      if (current.phase === "draft") {
        effectiveModel = selected;
        effectiveThinkingOptionId = supportsThinkingSelection
          ? draftThinkingOptionForModel(catalog, selected, previousThinking)
          : undefined;
        effectiveCatalog = catalog;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            previousPermissionModeId,
          )
        ) {
          throw new Error("External Model configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (previousModel && isCurrentModelRequest(mounted, generation)) {
            applyExternalConfiguration(
              mounted,
              agent,
              previousModel,
              previousThinking,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Model selection");
        }
        const state = await modelControl.selectThreadModel({ threadId, model: selected });
        if (
          !isCurrentModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (!state.effectiveModel) {
          throw new Error("External Harness did not confirm an effective Model");
        }
        effectiveModel = state.effectiveModel;
        if (!catalog.models.some((model) => model.ref.id === effectiveModel.id)) {
          throw new Error("External Harness activated a Model outside the current catalog");
        }
        effectiveThinkingOptionId = supportsThinkingSelection
          ? selectableThinkingOptionId(state)
          : undefined;
        effectiveCatalog = supportsThinkingSelection
          ? catalogWithConfigurationState(catalog, effectiveModel, state)
          : catalog;
        resolvedModelLabel = state.resolvedModelLabel;
        const effectivePermissionModeId =
          state.effectivePermissionModeId ?? previousPermissionModeId;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            effectiveModel,
            effectiveThinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed external Model could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrentModelRequest(mounted, generation)) return;
      controller.setExternalModel(mounted.composer, agent, effectiveModel);
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? previousPermissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          effectiveModel,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: effectiveModel,
        ...(effectiveThinkingOptionId
          ? { selectedThinkingOptionId: effectiveThinkingOptionId }
          : {}),
        ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      if (previousModel) {
        applyExternalConfiguration(
          mounted,
          agent,
          previousModel,
          previousThinking,
          previousPermissionModeId,
        );
      }
      mounted.modelView = {
        status: "error",
        catalog,
        ...(previousModel ? { selected: previousModel } : {}),
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: supportsThinkingSelection,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectPermissionMode = async (
    mounted: MountedComposer,
    permissionModeId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.permissionModeView.catalog;
    const selectedPermissionModeId = catalog?.modes.find(({ id }) => id === permissionModeId)?.id;
    const model = controller.modelForAgent(mounted.composer, agent);
    if (!catalog || !selectedPermissionModeId || !model || !modelControl) return;
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const thinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.permissionModeView = {
      status: "selecting",
      catalog,
      selected: previousPermissionModeId ?? selectedPermissionModeId,
    };
    renderMounted(mounted);
    try {
      let effectivePermissionModeId = selectedPermissionModeId;
      if (current.phase === "draft") {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            selectedPermissionModeId,
          )
        ) {
          throw new Error("Permission Mode could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyExternalConfiguration(
              mounted,
              agent,
              model,
              thinkingOptionId,
              previousPermissionModeId,
            );
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId) {
          throw new Error("External Thread identity is unavailable for Permission Mode selection");
        }
        const state = await modelControl.selectThreadPermissionMode({
          threadId,
          permissionModeId: selectedPermissionModeId,
        });
        if (
          !isCurrentModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (
          !state.effectivePermissionModeId ||
          !catalog.modes.some(({ id }) => id === state.effectivePermissionModeId)
        ) {
          throw new Error("External Harness did not report a selectable Permission Mode");
        }
        effectivePermissionModeId = state.effectivePermissionModeId;
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            thinkingOptionId,
            effectivePermissionModeId,
          )
        ) {
          throw new Error("Confirmed Permission Mode could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrentModelRequest(mounted, generation)) return;
      controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          thinkingOptionId,
          effectivePermissionModeId,
        );
        if (agent === "claude-code") {
          writeClaudePermissionModePreference(effectivePermissionModeId);
        }
      }
      mounted.permissionModeView = {
        status: "ready",
        catalog,
        selected: effectivePermissionModeId,
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      if (previousPermissionModeId) {
        applyExternalConfiguration(
          mounted,
          agent,
          model,
          thinkingOptionId,
          previousPermissionModeId,
        );
      }
      mounted.permissionModeView = {
        status: "error",
        catalog,
        ...(previousPermissionModeId ? { selected: previousPermissionModeId } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectExternalThinking = async (
    mounted: MountedComposer,
    thinkingOptionId: string,
  ): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const model = controller.modelForAgent(mounted.composer, agent);
    const permissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    const selectedThinkingOptionId = catalog?.thinkingOptions.find(
      ({ id }) => id === thinkingOptionId,
    )?.id;
    const catalogModel = catalog?.models.find((candidate) => candidate.ref.id === model?.id);
    if (
      !mounted.modelView.thinkingSelectionSupported ||
      !catalog ||
      !model ||
      !selectedThinkingOptionId ||
      !catalogModel?.supportedThinkingOptionIds?.includes(selectedThinkingOptionId)
    ) {
      return;
    }
    const previousThinking = controller.thinkingOptionForAgent(mounted.composer, agent);
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: model,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: true,
    };
    renderMounted(mounted);
    try {
      let effectiveThinkingOptionId = selectedThinkingOptionId;
      let effectiveCatalog = catalog;
      if (current.phase === "draft") {
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            selectedThinkingOptionId,
            permissionModeId,
          )
        ) {
          throw new Error("External Thinking could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId || !modelControl) {
          throw new Error("External Thread identity is unavailable for Thinking selection");
        }
        const state = await modelControl.selectThreadThinking({
          threadId,
          thinkingOptionId: selectedThinkingOptionId,
        });
        if (
          !isCurrentModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== agent
        ) {
          return;
        }
        if (state.effectiveModel && state.effectiveModel.id !== model.id) {
          throw new Error("External Harness changed Model during Thinking selection");
        }
        if (!state.effectiveThinkingOptionId) {
          throw new Error("External Harness did not confirm effective Thinking");
        }
        effectiveThinkingOptionId = state.effectiveThinkingOptionId;
        effectiveCatalog = catalogWithConfigurationState(catalog, model, state);
        if (
          !applyExternalConfiguration(
            mounted,
            agent,
            model,
            effectiveThinkingOptionId,
            state.effectivePermissionModeId ?? permissionModeId,
          )
        ) {
          throw new Error("Confirmed external Thinking could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrentModelRequest(mounted, generation)) return;
      controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
      const effectivePermissionModeId =
        mounted.threadConfiguration?.effectivePermissionModeId ?? permissionModeId;
      if (effectivePermissionModeId) {
        controller.setExternalPermissionMode(mounted.composer, agent, effectivePermissionModeId);
      }
      if (shouldPersistNewThreadConfigurationSelection(current.phase)) {
        writeNewThreadExternalConfigurationPreference(
          agent,
          model,
          effectiveThinkingOptionId,
          effectivePermissionModeId,
        );
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: model,
        selectedThinkingOptionId: effectiveThinkingOptionId,
        thinkingSelectionSupported: true,
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      applyExternalConfiguration(mounted, agent, model, previousThinking, permissionModeId);
      mounted.modelView = {
        status: "error",
        catalog,
        selected: model,
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: true,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const switchComposerAgent = async (
    mounted: MountedComposer,
    agent: RendererAgent,
  ): Promise<boolean> => {
    if (agent !== "codex" && activeHarnessAvailabilityState().availability[agent] !== "ready") {
      return false;
    }
    controller.clearPendingSubmission(mounted.composer);
    const composerId = controller.get(mounted.composer).composerId;
    controller.invalidateModelRequests(mounted.composer);
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent(nextAgent) {
        const model = controller.modelForAgent(mounted.composer, nextAgent);
        if (!shouldApplyDraftAgentCarrier(nextAgent, model)) return true;
        return (
          applyAdapterAgent?.(
            nextAgent,
            model,
            nextAgent !== "codex"
              ? controller.thinkingOptionForAgent(mounted.composer, nextAgent)
              : undefined,
            nextAgent !== "codex"
              ? controller.permissionModeForAgent(mounted.composer, nextAgent)
              : undefined,
            mounted.composer,
          ) ?? nextAgent === "codex"
        );
      },
      clearPrewarm: clearDraftPrewarm,
    });
    renderMounted(mounted);
    try {
      const switched = await switching;
      if (switched && controller.get(mounted.composer).agent !== "codex") {
        void loadExternalCatalog(mounted);
      } else if (controller.get(mounted.composer).agent === "codex") {
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
      }
      sidebarAgentIcons.refresh();
      return switched;
    } catch {
      adapterStatus = {
        ...adapterStatus,
        state: "unsupported",
        reason: "draft-prewarm-clear-failed",
        hook: null,
      };
      return false;
    } finally {
      for (const candidate of mountedByComposer.values()) {
        if (controller.get(candidate.composer).composerId === composerId) renderMounted(candidate);
      }
    }
  };

  const openInstallPage = (agent: ExternalRendererAgent): void => {
    const url = RENDERER_AGENT_INSTALL_URLS[agent];
    window.open(url, "_blank", "noopener,noreferrer");
  };

  function resetHarnessAvailabilityRetry(hostId: string): void {
    const state = hostHarnessAvailabilityState(hostId);
    if (state.retryTimer !== null) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryAttempt = 0;
  }

  function scheduleHarnessAvailabilityRetry(hostId: string): void {
    const state = hostHarnessAvailabilityState(hostId);
    if (
      disposed ||
      state.retryTimer !== null ||
      state.retryAttempt >= availabilityRetryDelays.length
    ) {
      return;
    }
    const delay = availabilityRetryDelays[state.retryAttempt];
    state.retryAttempt += 1;
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      void refreshHarnessAvailabilityForHost(hostId, true, true);
    }, delay);
  }

  function modelClientForHost(hostId: string): RendererModelClient | null {
    if (!modelControl) return null;
    const selected = modelControl.clientForHost?.(hostId);
    if (selected) return selected;
    const currentHostId = modelControl.currentHostId?.() ?? "local";
    return currentHostId === hostId ? modelControl : null;
  }

  function refreshHarnessAvailabilityForHost(
    hostId: string,
    refresh = false,
    retry = false,
    force = false,
  ): Promise<void> {
    const state = hostHarnessAvailabilityState(hostId);
    if (!retry) resetHarnessAvailabilityRetry(hostId);
    const client = modelClientForHost(hostId);
    if (!client) {
      scheduleHarnessAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    if (state.request?.client === client) return state.request.promise;
    const agentsToInspect = force
      ? externalAgents
      : passiveHarnessAvailabilityAgents(state.availability, state.errors);
    if (agentsToInspect.length === 0) {
      resetHarnessAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    const nextAvailability = { ...state.availability };
    for (const agent of agentsToInspect) {
      if (nextAvailability[agent] !== "ready") nextAvailability[agent] = "checking";
    }
    state.availability = nextAvailability;
    if (hostId === activeAvailabilityHostId) {
      publishConnectionStatus();
      for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    }
    const generation = ++state.requestGeneration;
    const promise = (async () => {
      await Promise.all(
        agentsToInspect.map(async (agent) => {
          let status: RendererAgentAvailability = "error";
          let nextError: CodexhostError | undefined;
          try {
            const inspection = await client.inspectHarness({
              harnessId: externalHarnessIds[agent],
              refresh,
            });
            status = inspection.status === "ready" ? "ready" : inspection.status;
            if (inspection.status !== "ready") {
              const error = inspection.error;
              nextError = {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                ...(error.stage ? { stage: error.stage } : {}),
                ...(error.durationMs !== undefined ? { durationMs: error.durationMs } : {}),
                ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}),
              };
            }
          } catch (error) {
            status = "error";
            nextError = {
              code: "internalError",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
              stage: "request",
            };
          }
          if (generation !== state.requestGeneration || disposed) return;
          const previousStatus = state.availability[agent];
          state.errors[agent] = nextError;
          state.availability = { ...state.availability, [agent]: status };
          if (hostId !== activeAvailabilityHostId) {
            publishConnectionStatus();
            return;
          }
          for (const mounted of mountedByComposer.values()) {
            const composerState = controller.get(mounted.composer);
            if (
              adapterStatus.state === "ready" &&
              composerState.phase === "draft" &&
              composerState.agent === agent &&
              status !== "ready"
            ) {
              await switchComposerAgent(mounted, "codex");
            }
          }
          for (const mounted of mountedByComposer.values()) {
            const composerState = controller.get(mounted.composer);
            if (
              composerState.agent === agent &&
              shouldReloadExternalCatalogAfterAvailabilityRefresh(
                previousStatus,
                status,
                isExternalConfigurationReady(mounted),
              )
            ) {
              void loadExternalCatalog(mounted);
            }
            renderMounted(mounted);
          }
          publishConnectionStatus();
        }),
      );
      if (generation !== state.requestGeneration || disposed) return;
      if (retryableHarnessAvailabilityAgents(state.availability, state.errors).length === 0) {
        resetHarnessAvailabilityRetry(hostId);
      } else {
        scheduleHarnessAvailabilityRetry(hostId);
      }
    })();
    const request = { client, promise };
    state.request = request;
    void promise.then(
      () => {
        if (state.request === request) state.request = null;
      },
      () => {
        if (state.request === request) state.request = null;
      },
    );
    return promise;
  }

  const reloadMountedOwnershipForHost = (hostId: string): void => {
    for (const mounted of mountedByComposer.values()) {
      if (mounted.hostId === hostId || !threadIdFromComposerModelTarget(mounted.modelTarget)) {
        continue;
      }
      const target = controllerTarget(mounted.modelTarget, hostId);
      if (controller.rebindConversation(mounted.composer, target) === null) {
        mounted.ownershipStatus = "error";
        renderMounted(mounted);
        continue;
      }
      mounted.hostId = hostId;
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      mounted.usage = null;
      mounted.accountCredits = null;
      mounted.usageRequestGeneration += 1;
      usageRefreshAttempts.delete(mounted.composer);
      const timer = usageRefreshTimers.get(mounted.composer);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        usageRefreshTimers.delete(mounted.composer);
      }
      renderMounted(mounted);
      void loadThreadOwnership(mounted);
    }
    sidebarAgentIcons.refresh();
  };

  function reconcileHarnessAvailabilityHost(): void {
    const hostId = activeModelHostId();
    if (!hostId || hostId === activeAvailabilityHostId) return;
    activeAvailabilityHostId = hostId;
    hostHarnessAvailabilityState(hostId);
    reloadMountedOwnershipForHost(hostId);
    publishConnectionStatus();
    for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    void refreshHarnessAvailabilityForHost(hostId);
  }

  const refreshHarnessAvailability = (refresh = false): Promise<void> => {
    reconcileHarnessAvailabilityHost();
    return refreshHarnessAvailabilityForHost(activeAvailabilityHostId, refresh);
  };

  connectionDiagnostics = {
    snapshot(): RendererConnectionSnapshot {
      const hostIds = [
        "local",
        ...[...harnessAvailabilityByHost.keys()].filter((hostId) => hostId !== "local").sort(),
      ];
      return {
        adapter: { ...adapterStatus },
        hosts: hostIds.map((hostId) => {
          const state = hostHarnessAvailabilityState(hostId);
          return {
            hostId,
            active: hostId === activeAvailabilityHostId,
            agents: externalAgents.map((agent) => ({
              agent,
              availability: state.availability[agent] ?? "checking",
              error: state.errors[agent] ?? null,
            })),
          };
        }),
      };
    },
    refresh(): Promise<void> {
      for (const hostId of harnessAvailabilityByHost.keys()) {
        void refreshHarnessAvailabilityForHost(hostId, true, false, true);
      }
      return Promise.resolve();
    },
    subscribe(listener: () => void): () => void {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
  };

  const mount = (composer: Element): void => {
    if (
      mountedByComposer.has(composer) ||
      !composer.isConnected ||
      !composer.matches(CODEX_COMPOSER_SELECTOR)
    ) {
      return;
    }
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const modelTarget = findComposerModelTarget(composer);
    const hostId = activeModelHostId();
    const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (!editor) return;
    const state = controller.mount(
      composer,
      controllerTarget(modelTarget, hostId),
      modelTarget?.[0] === "default" ? readNewThreadAgentPreference(enabledAgentSet) : undefined,
    );
    const inherited = pendingReplacements.get(composer)?.source;
    const control = mountComposerAgentControl(
      composer,
      state.composerId,
      sendButton,
      enabledAgents,
      (agent) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void switchComposerAgent(mounted, agent);
      },
      openInstallPage,
      (modelId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectExternalModel(mounted, modelId);
      },
      (thinkingOptionId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectExternalThinking(mounted, thinkingOptionId);
      },
      (permissionModeId) => {
        const mounted = mountedByComposer.get(composer);
        if (!composer.isConnected || !mounted) return;
        void selectPermissionMode(mounted, permissionModeId);
      },
      (command) => {
        const mounted = mountedByComposer.get(composer);
        if (mounted) void executeCommand(mounted, command);
      },
    );
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
      modelView: inherited?.modelView ?? { status: "idle" },
      permissionModeView: inherited?.permissionModeView ?? { status: "idle" },
      ownershipStatus: threadIdFromComposerModelTarget(modelTarget)
        ? inherited
          ? "ready"
          : "loading"
        : "not-required",
      threadConfiguration: inherited?.threadConfiguration,
      usage: inherited?.usage ?? null,
      accountCredits: inherited?.accountCredits ?? null,
      hostId: inherited?.hostId ?? hostId,
      usageRequestGeneration: 0,
    };
    mountedByComposer.set(composer, mounted);
    if (isComposerModelWriteAllowed(modelTarget)) {
      const model = controller.modelForAgent(composer, state.agent);
      if (shouldApplyDraftAgentCarrier(state.agent, model)) {
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        );
      }
    }
    renderMounted(mounted);
    sidebarAgentIcons.refresh();
    if (threadIdFromComposerModelTarget(modelTarget) && !inherited) {
      void loadThreadOwnership(mounted);
    } else if (
      threadIdFromComposerModelTarget(modelTarget) &&
      inherited &&
      shouldRetryExternalThreadUsage(state.agent, mounted.usage, mounted.accountCredits)
    ) {
      scheduleThreadUsageRefresh(mounted);
    } else if (state.agent !== "codex" && !isExternalConfigurationReady(mounted)) {
      void loadExternalCatalog(mounted);
    }
    void refreshCommands(mounted);
  };

  const scan = (): void => {
    scanScheduled = false;
    const refreshTargets = refreshTargetsOnNextScan;
    refreshTargetsOnNextScan = false;
    if (disposed) return;
    settingsLifecycle.refresh();
    for (const [target, replacement] of pendingReplacements) {
      const sourceState = controller.get(replacement.source.composer);
      const replacementTarget = findComposerModelTarget(target);
      const replacementHostId = activeModelHostId() ?? replacement.source.hostId;
      if (
        !shouldTransferComposerState(
          replacement.sourceModelTarget,
          replacementTarget,
          sourceState.phase,
          controller.isSubmissionPending(replacement.source.composer),
        ) ||
        !controller.transfer(
          replacement.source.composer,
          target,
          controllerTarget(replacementTarget, replacementHostId),
        )
      ) {
        pendingReplacements.delete(target);
      }
    }
    for (const [composer, mounted] of mountedByComposer) {
      if (
        !composer.isConnected ||
        !composer.matches(CODEX_COMPOSER_SELECTOR) ||
        !mounted.control.root.isConnected
      ) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(composer);
        const timer = usageRefreshTimers.get(composer);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          usageRefreshTimers.delete(composer);
        }
        disposeComposerAgentControl(mounted.control);
        mountedByComposer.delete(composer);
        continue;
      }
      const state = controller.get(composer);
      const hideCodexControls = controller.isSwitching(composer) || state.agent !== "codex";
      reconcileComposerNativeControls(mounted.control, hideCodexControls, hideCodexControls);
      if (refreshTargets) refreshMountedConversationTarget(mounted);
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mount(composer);
    }
    const localAvailability = hostHarnessAvailabilityState("local").availability;
    if (externalAgents.some((agent) => localAvailability[agent] === "checking")) {
      void refreshHarnessAvailabilityForHost("local");
    }
    reconcileHarnessAvailabilityHost();
    if (
      externalAgents.some(
        (agent) => activeHarnessAvailabilityState().availability[agent] === "checking",
      )
    ) {
      void refreshHarnessAvailability();
    }
    pendingReplacements.clear();
  };

  const scheduleScan = (refreshTargets = false): void => {
    refreshTargetsOnNextScan ||= refreshTargets;
    if (scanScheduled || disposed) return;
    scanScheduled = true;
    queueMicrotask(scan);
  };

  const composerRootsWithin = (node: Node): Element[] => {
    if (node.nodeType !== Node.ELEMENT_NODE) return [];
    const element = node as Element;
    const roots = element.matches(CODEX_COMPOSER_SELECTOR) ? [element] : [];
    roots.push(...element.querySelectorAll(CODEX_COMPOSER_SELECTOR));
    return roots;
  };

  const transferReplacedComposers = (mutations: MutationRecord[]): void => {
    const replacements = new Map<Node, { removed: Set<Element>; added: Set<Element> }>();
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      let replacement = replacements.get(mutation.target);
      if (!replacement) {
        replacement = { removed: new Set(), added: new Set() };
        replacements.set(mutation.target, replacement);
      }
      for (const removedNode of mutation.removedNodes) {
        for (const composer of mountedByComposer.keys()) {
          if (
            removedNode === composer ||
            (removedNode.nodeType === Node.ELEMENT_NODE &&
              (removedNode as Element).contains(composer))
          ) {
            replacement.removed.add(composer);
          }
        }
      }
      for (const addedNode of mutation.addedNodes) {
        for (const composer of composerRootsWithin(addedNode)) replacement.added.add(composer);
      }
    }
    for (const replacement of replacements.values()) {
      if (replacement.removed.size !== 1 || replacement.added.size !== 1) continue;
      const source = replacement.removed.values().next().value as Element;
      const target = replacement.added.values().next().value as Element;
      const mounted = mountedByComposer.get(source);
      if (source !== target && mounted) {
        pendingReplacements.set(target, {
          source: mounted,
          sourceModelTarget: mounted.modelTarget,
        });
      }
    }
  };

  const applyComposerAgent = (composer: Element): boolean => {
    const state = controller.get(composer);
    const mounted = mountedByComposer.get(composer);
    if (mounted?.modelTarget?.[0] === "conversation") {
      return state.phase === "locked" && mounted.ownershipStatus === "ready";
    }
    if (!mounted || !isComposerModelWriteAllowed(mounted.modelTarget)) return false;
    const model = controller.modelForAgent(composer, state.agent);
    if (!shouldApplyDraftAgentCarrier(state.agent, model)) return false;
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(
          state.agent,
          model,
          state.agent !== "codex"
            ? controller.thinkingOptionForAgent(composer, state.agent)
            : undefined,
          state.agent !== "codex"
            ? controller.permissionModeForAgent(composer, state.agent)
            : undefined,
          composer,
        ) ?? state.agent === "codex",
    );
  };
  const blockEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const prepareComposer = (composer: Element): boolean | null => {
    const mounted = mountedByComposer.get(composer);
    if (!mounted) return null;
    refreshMountedConversationTarget(mounted);
    const current = controller.get(composer);
    if (controller.isSwitching(composer) || isOwnershipSubmissionBlocked(mounted.ownershipStatus)) {
      return false;
    }
    if (!isExternalConfigurationReady(mounted)) return false;
    if (current.phase === "locked") return true;
    if (!applyComposerAgent(composer)) return false;
    controller.markSubmissionPending(composer);
    renderMounted(mounted);
    return true;
  };
  const composerForTarget = (target: EventTarget | null): Element | null => {
    const element = eventElement(target);
    const editor = element ? editorForElement(element) : null;
    const composer = editor ? composerForEditor(editor) : null;
    return composer && isMountedComposer(composer) ? composer : null;
  };
  const onBeforeInput = (event: InputEvent): void => {
    const composer = composerForTarget(event.target);
    if (!composer) return;
    controller.clearPendingSubmission(composer);
    const mounted = mountedByComposer.get(composer);
    if (mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) return;
    if (controller.isSwitching(composer) || !applyComposerAgent(composer)) blockEvent(event);
  };
  const onSubmit = (event: Event): void => {
    const element = eventElement(event.target);
    const candidate = element ? composerForElement(element) : null;
    const composer = candidate && isMountedComposer(candidate) ? candidate : null;
    if (!composer) return;
    const prepared = prepareComposer(composer);
    if (prepared === null) return;
    if (!prepared) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "submit");
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const composer = isComposerInputIntent(event) ? composerForTarget(event.target) : null;
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (composer && controller.isSwitching(composer)) {
      blockEvent(event);
      return;
    }
    if (composer && mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) {
      if (isComposerSubmissionKey(event)) blockEvent(event);
      return;
    }
    if (composer && !applyComposerAgent(composer)) {
      blockEvent(event);
      return;
    }
    if (!isComposerSubmissionKey(event) || !composer) return;
    if (!prepareComposer(composer)) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "enter");
  };
  const onClick = (event: MouseEvent): void => {
    const element = eventElement(event.target);
    const button = element?.closest<HTMLButtonElement>("button");
    if (!button) return;
    const candidate = composerForElement(button);
    const composer = candidate && isMountedComposer(candidate) ? candidate : null;
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (!composer || mounted?.control.sendButton !== button) return;
    if (!prepareComposer(composer)) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "click");
  };

  const mutationObserver = new MutationObserver((mutations) => {
    transferReplacedComposers(mutations);
    scheduleScan(mutations.some(mutationMayChangeComposerTarget));
  });
  const onHostRouteChange = (): void => {
    reconcileHarnessAvailabilityHost();
    void refreshHarnessAvailability();
  };
  const onAdapterStatus = () => {
    publishConnectionStatus();
    if (adapterStatus.state === "ready") {
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      void refreshHarnessAvailability();
      for (const mounted of mountedByComposer.values()) {
        if (
          mounted.modelView.status === "waitingForAdapter" &&
          mounted.composer.isConnected &&
          applyComposerAgent(mounted.composer)
        ) {
          void loadExternalCatalog(mounted);
        }
      }
    }
    for (const mounted of mountedByComposer.values()) renderMounted(mounted);
  };
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "data-codex-composer-root"],
    characterData: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  const onWindowFocus = (): void => {
    reconcileHarnessAvailabilityHost();
    const local = hostHarnessAvailabilityState("local");
    if (externalAgents.some((agent) => local.availability[agent] !== "ready")) {
      void refreshHarnessAvailabilityForHost("local", true);
    }
    const active = activeHarnessAvailabilityState();
    if (externalAgents.some((agent) => active.availability[agent] !== "ready")) {
      void refreshHarnessAvailability(true);
    }
  };
  window.addEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
  window.addEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
  window.addEventListener("focus", onWindowFocus);

  const connectedComposers = (): MountedComposer[] =>
    [...mountedByComposer.values()].filter(
      (mounted) => mounted.composer.isConnected && mounted.control.root.isConnected,
    );

  const api: RendererBindingProbeApi = {
    status() {
      const selections = connectedComposers().map((mounted) => ({
        composerId: mounted.composerId,
        agent: controller.get(mounted.composer).agent,
        phase: controller.get(mounted.composer).phase,
      }));
      return {
        version: 2,
        mountedComposers: selections.length,
        enabledAgents: [...enabledAgents],
        availability: { ...activeHarnessAvailabilityState().availability },
        selections,
        adapter: { ...adapterStatus },
      };
    },
    lockedSelection() {
      const locked = connectedComposers()
        .map((mounted) => ({ mounted, state: controller.get(mounted.composer) }))
        .filter(({ state }) => state.phase === "locked");
      const entry = locked[0];
      if (locked.length !== 1 || !entry) return null;
      const { mounted, state: selection } = entry;
      const model = controller.modelForAgent(mounted.composer, selection.agent);
      const thinkingOptionId =
        selection.agent !== "codex"
          ? controller.thinkingOptionForAgent(mounted.composer, selection.agent)
          : undefined;
      const permissionModeId =
        selection.agent !== "codex"
          ? controller.permissionModeForAgent(mounted.composer, selection.agent)
          : undefined;
      return {
        composerId: selection.composerId,
        agent: selection.agent,
        phase: "locked",
        ...(model ? { model } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(permissionModeId ? { permissionModeId } : {}),
      };
    },
    requestCompatibilityUpdate() {
      return startCompatibilityUpdate(modelControl);
    },
    setAdapter(status, dispose, applyAgent, nextModelControl) {
      usageNotificationDispose?.();
      usageNotificationDispose = null;
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      modelControl = nextModelControl ?? null;
      try {
        usageNotificationDispose =
          modelControl?.subscribeThreadUsage?.(applyThreadUsageUpdate) ?? null;
      } catch {
        usageNotificationDispose = null;
      }
      adapterStatus = status;
      publishConnectionStatus();
      const installedModelControl = modelControl;
      queueMicrotask(() => {
        if (disposed || modelControl !== installedModelControl) return;
        try {
          settingsLifecycle.refresh();
        } catch {
          // Auxiliary settings UI must not affect Agent routing compatibility.
        }
      });
      for (const state of harnessAvailabilityByHost.values()) {
        state.requestGeneration += 1;
        state.request = null;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      activeAvailabilityHostId = "local";
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      reconcileHarnessAvailabilityHost();
      const connected = connectedComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) {
          const state = controller.get(mounted.composer);
          if (
            threadIdFromComposerModelTarget(mounted.modelTarget) &&
            mounted.ownershipStatus !== "ready"
          ) {
            void loadThreadOwnership(mounted);
          } else if (state.agent !== "codex") {
            void loadExternalCatalog(mounted);
          } else if (isComposerModelWriteAllowed(mounted.modelTarget)) {
            applyComposerAgent(mounted.composer);
          }
        }
      }
      for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      usageNotificationDispose?.();
      usageNotificationDispose = null;
      adapterDispose?.();
      adapterDispose = null;
      applyAdapterAgent = null;
      modelControl = null;
      mutationObserver.disconnect();
      sidebarAgentIcons.dispose();
      settingsLifecycle.dispose();
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
      window.removeEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
      window.removeEventListener("focus", onWindowFocus);
      for (const state of harnessAvailabilityByHost.values()) {
        state.requestGeneration += 1;
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      for (const timer of usageRefreshTimers.values()) window.clearTimeout(timer);
      usageRefreshTimers.clear();
      for (const mounted of mountedByComposer.values()) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(mounted.composer);
        disposeComposerAgentControl(mounted.control);
      }
      mountedByComposer.clear();
      pendingReplacements.clear();
      connectionListeners.clear();
      connectionDiagnostics = null;
      delete window.__codexhostRendererBindingProbeV1;
    },
  };
  window.__codexhostRendererBindingProbeV1 = api;
  scan();
  return api;
}
