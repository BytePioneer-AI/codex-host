import { createRemoteConnectionsControl } from "./remote-connections-control.js";
import { isOrbitComposer } from "./renderer-composer-kind.js";
import { handleRemoteConnectionsRequest } from "./remote-connections-request.js";
import {
  catalogModelForRef,
  decodeHarnessPluginRoute,
  harnessIdSchema,
  permissionModeFixedAtCreate,
  type HarnessCommandDescriptor,
  type HarnessPluginDescriptor,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessPermissionModeScope,
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
  refreshSendButton,
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
  rendererHarnessMessages,
  rendererLiveCommandsPendingNotice,
} from "./renderer-harness-localization.js";
import {
  installReasoningTranscriptSoftWrap,
  TRANSCRIPT_ITEM_SELECTOR,
} from "./renderer-transcript-dom.js";
import { RendererCodexAccountState } from "./renderer-codex-account-state.js";
import {
  createRendererCodexUsageGate,
  type RendererCodexUsageGate,
  type RendererCodexUsageGateStatus,
} from "./renderer-codex-usage-gate.js";
import {
  decodeAntigravityTransportModelId,
  decodeClaudeTransportModelId,
  decodeDeepSeekHarnessTransportModelId,
  decodeGrokTransportModelId,
  decodeOmpTransportModelId,
  decodeOpenCodeTransportModelId,
  decodePiTransportModelId,
  findComposerModelTarget,
  threadIdFromComposerModelTarget,
  waitForRendererDraftPrewarmPolicy,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { readClaudePermissionModePreference } from "./renderer-permission-mode-preference.js";
import { isPermissionModeControlReady } from "./renderer-permission-mode-picker.js";
import {
  readNewThreadAgentPreference,
  rendererNewThreadPreferenceStorage,
  readNewThreadExternalConfigurationPreference,
  writeNewThreadAgentPreference,
  writeNewThreadExternalConfigurationPreference,
} from "./renderer-new-thread-preference.js";
import {
  installRendererSidebarAgentIcons,
  SIDEBAR_THREAD_ROW_SELECTOR,
} from "./renderer-sidebar-agent-icons.js";
import {
  rendererHarnessCommandExecutesDirectly,
  routeRendererHarnessCommandSelection,
} from "./renderer-harness-command-claim.js";
import { installRendererSettingsLifecycle } from "./renderer-settings-lifecycle.js";
import {
  installRendererDelegationMention,
  type RendererDelegationMentionControl,
} from "./renderer-delegation-mention.js";
import { compatibleRendererPluginPresentation, rendererAgentLabel } from "./renderer-agent-icon.js";
import { openRendererThread } from "./renderer-fork-control.js";
import type {
  RendererConnectionDiagnostics,
  RendererConnectionSnapshot,
} from "./settings/pages.js";

const EMPTY_PLUGINS: readonly HarnessPluginDescriptor[] = [];
type HarnessAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;
type HarnessAvailabilityErrors = Partial<Record<ExternalRendererAgent, CodexhostError | undefined>>;
type HarnessWebUiAvailability = Record<ExternalRendererAgent, boolean>;

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
  return Object.keys(availability).filter((agent) =>
    isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

export function passiveHarnessAvailabilityAgents(
  availability: HarnessAvailability,
  errors: HarnessAvailabilityErrors,
): ExternalRendererAgent[] {
  return Object.keys(availability).filter(
    (agent) =>
      availability[agent] === "checking" ||
      isRetryableHarnessAvailability(availability[agent], errors[agent]),
  );
}

/** Last known availability stays visible while inspect or retry is in flight. */
export function harnessAvailabilityDuringInspect(
  current: RendererAgentAvailability | undefined,
): RendererAgentAvailability {
  return current ?? "checking";
}

export function shouldRefreshCodexAccountsForAdapterState(
  state: RendererAdapterStatus["state"],
): boolean {
  return state === "ready";
}

export { resolveCurrentCodexAccountId } from "./renderer-codex-account-state.js";

interface HostHarnessAvailabilityState {
  plugins: readonly HarnessPluginDescriptor[] | null;
  directoryClient: RendererModelClient | null;
  directoryError?: string;
  codexAccounts: RendererCodexAccountState | null;
  availability: HarnessAvailability;
  errors: HarnessAvailabilityErrors;
  webUi: HarnessWebUiAvailability;
  requestGeneration: number;
  request: { client: RendererModelClient; promise: Promise<void> } | null;
  retryTimer: number | null;
  retryAttempt: number;
}

const rendererUsageRefreshDelays = [250, 500, 1000, 2000, 4000, 8000] as const;

export function refreshConnectionHosts(
  hostIds: Iterable<string>,
  refreshHost: (hostId: string) => Promise<void>,
  pendingHost?: (hostId: string) => Promise<void> | undefined,
): Promise<void> {
  return Promise.all(
    [...hostIds].map(async (hostId) => {
      // Mutation readback must not reuse an observation started before the mutation.
      // Drain it even if it failed; the new inspection owns the resulting status.
      if (pendingHost) await pendingHost(hostId)?.catch(() => undefined);
      await refreshHost(hostId);
    }),
  ).then(() => undefined);
}

export function rendererUsageRefreshDelay(attempt: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attempt), rendererUsageRefreshDelays.length - 1));
  return rendererUsageRefreshDelays[index] ?? rendererUsageRefreshDelays[0];
}

/**
 * Agents that can produce account-wide Credits independently of a Thread
 * Usage snapshot. These are the only ones where it is worth retrying purely
 * to pick up account limits after Usage has already arrived.
 */
function externalAgentHasAccountCredits(agent: RendererAgent): boolean {
  return agent === "codex" || agent === "grok" || agent === "claude-code";
}

export function shouldRetryExternalThreadUsage(
  agent: RendererAgent,
  usage: ThreadUsageSnapshot | null,
  accountCredits: AccountCreditsSnapshot | null = null,
): boolean {
  if (usage === null) return true;
  return externalAgentHasAccountCredits(agent) && accountCredits === null;
}

export function shouldReloadExternalCatalogAfterAvailabilityRefresh(
  previous: RendererAgentAvailability | undefined,
  next: RendererAgentAvailability,
  configurationReady: boolean,
  explicitRefresh = false,
): boolean {
  // A foreground inspection may already have loaded this catalog while the
  // initial background discovery was queued. Do not blank it a second time.
  const initialDiscoveryReady = previous === "checking" && next === "ready";
  return explicitRefresh || (!initialDiscoveryReady && previous !== next) || !configurationReady;
}

function isExternalConfigurationReadyView(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    modelView.status !== "selecting" &&
    catalogModelForRef(modelView.catalog, modelView.selected) !== undefined &&
    isPermissionModeControlReady(permissionModeView)
  );
}

function isExternalConfigurationStable(
  modelView: ExternalModelControlView,
  permissionModeView: ExternalPermissionModeControlView,
): boolean {
  return (
    (modelView.status === "empty" && isPermissionModeControlReady(permissionModeView)) ||
    isExternalConfigurationReadyView(modelView, permissionModeView)
  );
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
  remoteConnections(request: unknown): Promise<unknown>;
  status(): RendererBindingProbeStatus;
  currentThreadId(): string | null;
  lockedSelection(): LockedComposerSelection | null;
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

export function lockedPermissionMode(
  catalog: HarnessPermissionModeCatalog,
  effective: HarnessPermissionModeId | undefined,
  carrier: HarnessPermissionModeId | undefined,
): HarnessPermissionModeId | undefined {
  const restored = effective ?? carrier;
  if (restored && !catalog.modes.some(({ id }) => id === restored)) {
    throw new Error("Existing Thread Permission Mode is absent from the current Catalog");
  }
  return restored;
}

export function permissionModeSelectionLocked(input: {
  phase: ComposerAgentPhase;
  permissionModeScope?: HarnessPermissionModeScope;
}): boolean {
  return input.phase === "locked" && permissionModeFixedAtCreate(input);
}

export function shouldPersistNewThreadConfigurationSelection(phase: ComposerAgentPhase): boolean {
  return phase === "draft";
}

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  const route = decodeHarnessPluginRoute(inspection.transportModelId);
  if (route) {
    if (route.harnessId !== inspection.harnessId)
      throw new Error("Thread plugin identity mismatch");
    const model = inspection.effectiveModel ?? route.model;
    const thinkingOptionId =
      inspection.availableThinkingOptions !== undefined
        ? selectableThinkingOptionId(inspection)
        : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? route.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  // Read-only compatibility for Threads created before the shared plugin carrier.
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
  if (inspection.harnessId === "omp") {
    const transportSelection = decodeOmpTransportModelId(inspection.transportModelId);
    if (!transportSelection) throw new Error("OMP Thread reported an incompatible transport Model");
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "omp",
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
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "deepseek-harness",
      ...(model ? { model } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "opencode") {
    const transportSelection = decodeOpenCodeTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("OpenCode Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "opencode",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "antigravity") {
    const transportSelection = decodeAntigravityTransportModelId(inspection.transportModelId);
    if (!transportSelection) {
      throw new Error("Antigravity Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? transportSelection.model;
    const thinkingOptionId =
      selectableThinkingOptionId(inspection) ?? transportSelection.thinkingOptionId;
    const permissionModeId =
      inspection.effectivePermissionModeId ?? transportSelection.permissionModeId;
    return {
      agent: "antigravity",
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (
    inspection.harnessId === "kiro-cli" ||
    inspection.harnessId === "codebuddy" ||
    inspection.harnessId === "workbuddy" ||
    inspection.harnessId === "cursor-cli"
  ) {
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== inspection.harnessId) {
      throw new Error("Plugin Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? route.model;
    const thinkingOptionId =
      inspection.harnessId === "cursor-cli"
        ? undefined
        : inspection.availableThinkingOptions !== undefined
          ? selectableThinkingOptionId(inspection)
          : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? route.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "hermes") {
    // Hermes rides the shared harness-plugin route; effective configuration
    // comes from the Thread inspection, not a Harness-specific codec.
    return {
      agent: "hermes",
      ...(inspection.effectiveModel ? { model: inspection.effectiveModel } : {}),
      ...(inspection.effectivePermissionModeId
        ? { permissionModeId: inspection.effectivePermissionModeId }
        : {}),
    };
  }
  if (inspection.harnessId === "qoder" || inspection.harnessId === "qoder-cn") {
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== inspection.harnessId) {
      throw new Error("Harness Thread reported an incompatible transport Model");
    }
    const model = inspection.effectiveModel ?? route.model;
    const thinkingOptionId =
      inspection.availableThinkingOptions !== undefined
        ? selectableThinkingOptionId(inspection)
        : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? route.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
  }
  if (inspection.harnessId === "kimi-code" || inspection.harnessId === "zcode") {
    const route = decodeHarnessPluginRoute(inspection.transportModelId);
    if (!route || route.harnessId !== inspection.harnessId) {
      throw new Error(`${inspection.harnessId} Thread reported an incompatible transport Model`);
    }
    const model = inspection.effectiveModel ?? route.model;
    const thinkingOptionId =
      inspection.availableThinkingOptions !== undefined
        ? selectableThinkingOptionId(inspection)
        : (inspection.effectiveThinkingOptionId ?? route.thinkingOptionId);
    const permissionModeId = inspection.effectivePermissionModeId ?? route.permissionModeId;
    return {
      agent: inspection.harnessId,
      ...(model ? { model } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(permissionModeId ? { permissionModeId } : {}),
    };
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
  codexUsageGate: RendererCodexUsageGate;
  modelTarget: readonly unknown[] | null;
  modelView: ExternalModelControlView;
  permissionModeView: ExternalPermissionModeControlView;
  ownershipStatus: ComposerOwnershipStatus;
  threadConfiguration: HarnessModelSelectionState | undefined;
  usage: ThreadUsageSnapshot | null;
  accountCredits: AccountCreditsSnapshot | null;
  hostId: string | null;
  usageRequestGeneration: number;
  commandRequestGeneration: number;
}

interface MountedCatalogRequest {
  client: RendererModelClient;
  hostId: string;
  agent: ExternalRendererAgent;
  generation: number;
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
  if (
    sourceTarget.length === replacementTarget.length &&
    sourceTarget.every((value, index) => value === replacementTarget[index])
  ) {
    return true;
  }
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

export function applyComposerModelWrite(
  target: readonly unknown[] | null,
  write: () => boolean,
): boolean {
  if (target?.[0] === "conversation") return true;
  if (!isComposerModelWriteAllowed(target)) return false;
  return write();
}

export function mutationMayAffectComposer(mutation: MutationRecord): boolean {
  const target =
    mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (!target) return true;
  // Identity changes are lifecycle events even after the marker is removed.
  if (mutation.type === "attributes" && mutation.attributeName === "data-codex-composer-root")
    return true;
  // Text/IME and rich-text changes inside an editor do not change its owner.
  if (mutation.type !== "attributes" && editorForElement(target)) return false;
  if (target.closest(CODEX_COMPOSER_SELECTOR)) return true;
  if (mutation.type === "characterData") return false;
  if (
    !target.closest(
      `${TRANSCRIPT_ITEM_SELECTOR}, [data-turn-key], [data-content-search-turn-key], [data-app-action-sidebar-scroll], [data-app-action-sidebar-section], ${SIDEBAR_THREAD_ROW_SELECTOR}`,
    )
  )
    return true;
  // Transcript/sidebar updates do not change Composer ownership. Still handle
  // actual Composer insertion/removal and visibility changes of their ancestors.
  if (mutation.type === "attributes") return target.querySelector(CODEX_COMPOSER_SELECTOR) !== null;
  return (
    mutation.type === "childList" &&
    [...mutation.addedNodes, ...mutation.removedNodes].some(
      (node) =>
        node instanceof Element &&
        (node.matches(CODEX_COMPOSER_SELECTOR) || node.querySelector(CODEX_COMPOSER_SELECTOR)),
    )
  );
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
    return candidate === catalogModelForRef(catalog, model)
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
  const controller = new DraftAgentController<Element>({
    enabledAgents,
    ...(options.defaultAgent ? { defaultAgent: options.defaultAgent } : {}),
  });
  const mountedByComposer = new Map<Element, MountedComposer>();
  const catalogRequests = new WeakMap<MountedComposer, MountedCatalogRequest>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  let disposed = false;
  const disposeReasoningSoftWrap = installReasoningTranscriptSoftWrap(document);
  let scanScheduled = false;
  let refreshTargetsOnNextScan = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ApplyAdapterAgent | null = null;
  let modelControl: RendererModelClient | null = null;
  const activeModelHostId = (composer?: Element): string | null => {
    if (!modelControl) return null;
    return modelControl.currentHostId ? modelControl.currentHostId(composer) : "local";
  };
  const controllerTarget = (target: readonly unknown[] | null, hostId: string | null) =>
    scopedComposerTarget(target, hostId);
  const usageSubscriptions = new Map<
    string,
    { client: RendererModelClient; dispose: () => void }
  >();
  const usageNotificationDispose = (): void => {
    for (const subscription of usageSubscriptions.values()) subscription.dispose();
    usageSubscriptions.clear();
  };
  const localAgentForSidebarThread = (input: {
    hostId: string;
    threadId: string | null;
    draftId: string | null;
  }): RendererAgent | null => {
    for (const mounted of mountedByComposer.values()) {
      const target = mounted.modelTarget;
      const matchesDraft =
        target?.[0] === "default" && input.draftId !== null && target[1] === input.draftId;
      const matchesConversation =
        target?.[0] === "conversation" &&
        input.threadId !== null &&
        target[1] === input.threadId &&
        mounted.ownershipStatus === "ready";
      if (!matchesDraft && !matchesConversation) continue;
      // Route validation walks the committed React tree. Only a row matching a
      // mounted Composer needs it; unrelated sidebar rows cannot use local state.
      const mountedHostId = activeModelHostId(mounted.composer);
      if (input.hostId !== mountedHostId) return null;
      return controller.get(mounted.composer).agent;
    }
    return null;
  };
  const sidebarAgentIcons = installRendererSidebarAgentIcons({
    getClient: (hostId) => modelClientForHost(hostId),
    getPlugins: (hostId) => {
      const state = hostHarnessAvailabilityState(hostId);
      const client = modelClientForHost(hostId);
      // Sidebar ownership is enough to discover this Host's artwork; opening a Composer
      // must not be required. Keep directory requests deduplicated and client-scoped.
      if (
        client &&
        (state.directoryClient !== client || (!state.plugins && !state.directoryError))
      ) {
        void refreshHarnessAvailabilityForHost(hostId);
      }
      return state.directoryClient === client
        ? state.plugins?.map((plugin) => pluginForHost(hostId, plugin.id) ?? plugin)
        : undefined;
    },
    getLocalAgent: localAgentForSidebarThread,
  });
  let connectionDiagnostics: RendererConnectionDiagnostics | null = null;
  const remoteConnections = createRemoteConnectionsControl(window, modelClientForHost);
  const settingsLifecycle = installRendererSettingsLifecycle(window, {
    getRemoteConnections: () => remoteConnections,
    getUpdateClient: () => modelControl,
    getAccountClient: () => modelControl,
    getConnectionDiagnostics: () => connectionDiagnostics,
    getLoadedSessionsClient: () => modelClientForHost("local"),
    async requestUsageStatistics(method, params) {
      const route = window.__codexhostHostRoutingV1?.forHost("local");
      if (disposed || !route) throw new Error("Local Host connection is unavailable");
      return route.manager.sendRequest(method, params);
    },
    getSessionImportClient: () => {
      const client = modelClientForHost("local");
      const sources = client?.listSessionImportSources;
      const list = client?.listHarnessSessions;
      const importSession = client?.importHarnessSession;
      if (!sources || !list || !importSession) return null;
      return {
        listSessionImportSources: () => sources(),
        listHarnessSessions: (input) => list(input),
        importHarnessSession: (input) => importSession(input),
      };
    },
    openImportedThread: (threadId, signal) =>
      openRendererThread(threadId, { hostId: "local", signal }),
    onLocaleChange() {
      for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    },
  });
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };
  const createHostHarnessAvailabilityState = (): HostHarnessAvailabilityState => ({
    plugins: null,
    directoryClient: null,
    codexAccounts: null,
    availability: {},
    errors: {},
    webUi: {},
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
  function pluginForHost(hostId: string, agent: string): HarnessPluginDescriptor | undefined {
    const plugin = hostHarnessAvailabilityState(hostId).plugins?.find(({ id }) => id === agent);
    const reference =
      hostId === "local"
        ? undefined
        : hostHarnessAvailabilityState("local").plugins?.find(({ id }) => id === agent);
    return compatibleRendererPluginPresentation(plugin, reference);
  }
  const codexAccountsForHost = (hostId: string | null): RendererCodexAccountState | null => {
    if (!hostId) return null;
    const client = modelClientForHost(hostId);
    if (!client) return null;
    const state = hostHarnessAvailabilityState(hostId);
    if (state.codexAccounts?.client !== client) {
      state.codexAccounts?.dispose();
      state.codexAccounts = new RendererCodexAccountState(client, () => {
        queueMicrotask(() => {
          if (disposed || hostHarnessAvailabilityState(hostId).codexAccounts?.client !== client)
            return;
          for (const mounted of mountedByComposer.values()) {
            if (mounted.hostId !== hostId) continue;
            renderMounted(mounted);
            void refreshDraftCodexUsage(mounted);
          }
        });
      });
    }
    return state.codexAccounts;
  };
  const composerCodexAccounts = (composer: Element): RendererCodexAccountState | null =>
    codexAccountsForHost(mountedByComposer.get(composer)?.hostId ?? null);
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
    !isOrbitComposer(composer) &&
    mountedByComposer.has(composer);

  const isCurrentModelRequest = (mounted: MountedComposer, generation: number): boolean =>
    isMountedComposer(mounted.composer) &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentModelRequest(mounted.composer, generation);

  const isCurrentOwnershipRequest = (mounted: MountedComposer, generation: number): boolean =>
    isMountedComposer(mounted.composer) &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentOwnershipRequest(mounted.composer, generation);

  const notifySubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const state = controller.recordSubmission(composer);
    const preferenceStorage = rendererNewThreadPreferenceStorage(activeModelHostId(composer));
    writeNewThreadAgentPreference(state.agent, preferenceStorage);
    if (state.agent !== "codex") {
      const model = controller.modelForAgent(composer, state.agent);
      if (model) {
        writeNewThreadExternalConfigurationPreference(
          state.agent,
          model,
          controller.thinkingOptionForAgent(composer, state.agent),
          controller.permissionModeForAgent(composer, state.agent),
          preferenceStorage,
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

  const showCodexUsageGateStatus = (
    mounted: MountedComposer,
    status: RendererCodexUsageGateStatus,
  ): void => {
    const title =
      status === "unsupported"
        ? rendererHarnessMessages(settingsLifecycle.locale).codexUsageGateUnavailable
        : "";
    if (mounted.control.root.title !== title) mounted.control.root.title = title;
  };

  const composerClient = (mounted: MountedComposer): RendererModelClient | null =>
    mounted.hostId ? modelClientForHost(mounted.hostId) : null;
  const composerAvailability = (mounted: MountedComposer) => {
    if (!mounted.hostId) return {};
    const state = hostHarnessAvailabilityState(mounted.hostId);
    const agent = controller.get(mounted.composer).agent;
    return state.plugins && agent !== "codex" && !state.plugins.some(({ id }) => id === agent)
      ? { ...state.availability, [agent]: "unavailable" as const }
      : state.availability;
  };
  const composerAdapterState = (mounted: MountedComposer): RendererAdapterStatus["state"] =>
    composerClient(mounted) ? "ready" : "installing";

  const renderMounted = (mounted: MountedComposer): void => {
    if (!isMountedComposer(mounted.composer)) return;
    const hostId = mounted.hostId;
    mounted.control.setPlugins(
      hostId
        ? (hostHarnessAvailabilityState(hostId).plugins ?? EMPTY_PLUGINS).map(
            (plugin) => pluginForHost(hostId, plugin.id) ?? plugin,
          )
        : EMPTY_PLUGINS,
    );
    const accounts = composerCodexAccounts(mounted.composer);
    const currentCodexAccount = accounts?.accounts.find(
      ({ accountId }) => accountId === accounts.readyAccountId,
    );
    const externalSubmissionReady = renderComposerAgentControl(
      mounted.control,
      controller.get(mounted.composer),
      composerAdapterState(mounted),
      controller.isSwitching(mounted.composer) || mounted.ownershipStatus === "loading",
      composerAvailability(mounted),
      mounted.modelView,
      mounted.permissionModeView,
      mounted.usage,
      mounted.accountCredits,
      settingsLifecycle.locale,
      currentCodexAccount ?? null,
      mounted.ownershipStatus === "error",
    );
    showCodexUsageGateStatus(mounted, mounted.codexUsageGate.update(externalSubmissionReady));
    if (mounted.control.usage) {
      mounted.control.usage.onOpen = () => {
        void refreshThreadUsage(
          mounted,
          controller.get(mounted.composer).agent === "codex" ? undefined : "exact",
        );
      };
    }
  };

  let delegationMention: RendererDelegationMentionControl | null = null;
  /**
   * Workspace of each Host's current draft, published by the draft prewarm
   * (the only place Desktop names it). A draft asks the Host for that
   * workspace's live commands and skills.
   */
  const draftWorkspaces = new Map<string, string>();
  {
    const published: unknown = Reflect.get(window, "__codexhostDraftWorkspacesV1");
    if (typeof published === "object" && published !== null) {
      for (const [hostId, cwd] of Object.entries(published)) {
        if (typeof cwd === "string" && cwd.length > 0) draftWorkspaces.set(hostId, cwd);
      }
    }
  }
  /**
   * `keepCurrent` refreshes in place (the `#` menu reopening) instead of
   * clearing first, so an open menu never flickers empty.
   */
  const refreshCommands = async (
    mounted: MountedComposer,
    { keepCurrent = false }: { keepCurrent?: boolean } = {},
  ): Promise<void> => {
    const generation = ++mounted.commandRequestGeneration;
    const agent = controller.get(mounted.composer).agent;
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    const hostId = threadId ? mounted.hostId : activeModelHostId(mounted.composer);
    const requestControl = modelControl;
    const client = modelClientForHostFrom(requestControl, hostId);
    if (!keepCurrent || agent === "codex") mounted.control.harnessCommands.setCommands([]);
    if (agent === "codex" || !client) return;
    try {
      // A Thread's loaded Session reports its live catalog (custom commands,
      // skills); the Host falls back to the static Adapter catalog otherwise.
      const catalog = threadId
        ? await client.inspectThreadCommands({ threadId })
        : await client.inspectHarnessCommands({
            harnessId: harnessIdSchema.parse(agent),
            ...(hostId && draftWorkspaces.has(hostId) ? { cwd: draftWorkspaces.get(hostId) } : {}),
          });
      if (
        disposed ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        mounted.commandRequestGeneration !== generation ||
        requestControl !== modelControl ||
        (threadIdFromComposerModelTarget(mounted.modelTarget)
          ? mounted.hostId
          : activeModelHostId(mounted.composer)) !== hostId ||
        controller.get(mounted.composer).agent !== agent
      )
        return;
      mounted.control.harnessCommands.setCommands(
        catalog.commands,
        threadIdFromComposerModelTarget(mounted.modelTarget) !== null,
        catalog.source,
      );
      delegationMention?.refresh();
    } catch {
      // Keep the entry unavailable. Never open a Session as a catalog fallback.
    }
  };

  const executeCommand = async (
    mounted: MountedComposer,
    command: HarnessCommandDescriptor,
  ): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId || !modelControl || controller.get(mounted.composer).agent === "codex") return;
    const client = composerClient(mounted);
    if (!client) return;
    mounted.control.harnessCommands.setExecuting(command.id);
    try {
      await client.executeThreadCommand({ threadId, commandId: command.id });
    } catch (error) {
      console.error(
        "codexhost Harness command failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      mounted.control.harnessCommands.setExecuting(null);
    }
  };

  const selectCommand = (mounted: MountedComposer, command: HarnessCommandDescriptor): void => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!modelControl || controller.get(mounted.composer).agent === "codex") return;
    if (!threadId && rendererHarnessCommandExecutesDirectly(command)) return;
    const editor = mounted.composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (
      routeRendererHarnessCommandSelection(editor, command, () => {
        void executeCommand(mounted, command);
      })
    ) {
      return;
    }
    console.error("codexhost Harness command could not claim the current Composer editor");
  };

  const applyThreadUsageUpdate = (hostId: string, update: ThreadUsageInspection): void => {
    for (const mounted of mountedByComposer.values()) {
      if (
        mounted.hostId !== hostId ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== update.threadId
      )
        continue;
      mounted.usageRequestGeneration += 1;
      mounted.usage = update.usage;
      mounted.accountCredits = update.accountCredits ?? null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
    }
  };

  const refreshDraftCodexUsage = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (
      state.agent !== "codex" ||
      state.phase !== "draft" ||
      controller.isSubmissionPending(mounted.composer) ||
      threadIdFromComposerModelTarget(mounted.modelTarget)
    )
      return;
    const accounts = composerCodexAccounts(mounted.composer);
    const client = accounts?.client;
    const accountId = accounts?.readyAccountId;
    const hostId = mounted.hostId;
    const generation = ++mounted.usageRequestGeneration;
    mounted.usage = null;
    mounted.accountCredits = null;
    renderMounted(mounted);
    if (!accountId || !client?.inspectCodexAccountUsage) return;
    try {
      const result = await client.inspectCodexAccountUsage({ accountId });
      if (
        disposed ||
        mounted.hostId !== hostId ||
        composerCodexAccounts(mounted.composer) !== accounts ||
        !mounted.composer.isConnected ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        mounted.usageRequestGeneration !== generation ||
        controller.get(mounted.composer).agent !== "codex" ||
        controller.get(mounted.composer).phase !== "draft" ||
        controller.isSubmissionPending(mounted.composer) ||
        threadIdFromComposerModelTarget(mounted.modelTarget) ||
        accounts.readyAccountId !== accountId ||
        result.accountId !== accountId
      )
        return;
      mounted.usage = result.usage;
      mounted.accountCredits = result.accountCredits ?? null;
      renderMounted(mounted);
    } catch {
      // Leave unknown quota empty instead of retaining a different Account's values.
    }
  };

  const refreshThreadUsage = async (mounted: MountedComposer, refresh?: "exact"): Promise<void> => {
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId && controller.get(mounted.composer).agent === "codex") {
      await refreshDraftCodexUsage(mounted);
      return;
    }
    if (!threadId || !modelControl) {
      mounted.usage = null;
      mounted.accountCredits = null;
      usageRefreshAttempts.delete(mounted.composer);
      renderMounted(mounted);
      return;
    }
    const hostId = mounted.hostId;
    const client = composerClient(mounted);
    if (!client) return;
    const generation = ++mounted.usageRequestGeneration;
    try {
      const result = await client.inspectThreadUsage({
        threadId,
        ...(refresh ? { refresh } : {}),
      });
      if (
        disposed ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        !mounted.composer.isConnected ||
        mounted.usageRequestGeneration !== generation ||
        mounted.hostId !== hostId ||
        composerClient(mounted) !== client ||
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
    } catch (error) {
      if (
        mountedByComposer.get(mounted.composer) === mounted &&
        mounted.usageRequestGeneration === generation
      ) {
        renderMounted(mounted);
        if (
          !(error instanceof RendererMethodUnavailableError) &&
          shouldRetryExternalThreadUsage(controller.get(mounted.composer).agent, null, null)
        ) {
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
    return isExternalConfigurationReadyView(mounted.modelView, mounted.permissionModeView);
  };

  const clearDraftPrewarm = async (composer: Element): Promise<void> => {
    const policy = await waitForRendererDraftPrewarmPolicy(window, composer);
    await policy.clear();
  };

  const applyDraftAgentCarrier = (composer: Element, agent: RendererAgent): boolean => {
    if (isOrbitComposer(composer)) return false;
    const model = controller.modelForAgent(composer, agent);
    const hasConcreteModel = model !== undefined;
    return (
      applyAdapterAgent?.(
        agent,
        model,
        agent !== "codex" && hasConcreteModel
          ? controller.thinkingOptionForAgent(composer, agent)
          : undefined,
        agent !== "codex" && hasConcreteModel
          ? controller.permissionModeForAgent(composer, agent)
          : undefined,
        composer,
      ) ?? agent === "codex"
    );
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
    if (!isMountedComposer(mounted.composer)) return;
    const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
    if (!threadId) {
      mounted.ownershipStatus = "not-required";
      return;
    }
    const requestModelControl = modelControl;
    const requestHostId = activeModelHostId(mounted.composer);
    const client = modelClientForHostFrom(requestModelControl, requestHostId);
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
        activeModelHostId(mounted.composer) !== requestHostId
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
          if (agent === "codex") {
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
    const nextHostId = activeModelHostId(mounted.composer);
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
    void refreshCommands(mounted);
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
    const requestModelControl = modelControl;
    const isDraft = !threadIdFromComposerModelTarget(mounted.modelTarget);
    const requestHostId = isDraft ? activeModelHostId(mounted.composer) : mounted.hostId;
    if (!requestHostId) {
      mounted.modelView = {
        status: "waitingForAdapter",
        thinkingSelectionSupported: false,
      };
      mounted.permissionModeView = { status: "idle" };
      renderMounted(mounted);
      return;
    }
    if (isDraft) mounted.hostId = requestHostId;
    const hostState = hostHarnessAvailabilityState(requestHostId);
    if (!hostState.plugins) void refreshHarnessAvailabilityForHost(requestHostId);
    const availability =
      hostState.availability[agent] ?? (hostState.plugins ? "unavailable" : "checking");
    // The selected Harness inspection already validates availability. Waiting
    // for its background discovery first would defeat interactive scheduling.
    if (availability !== "ready" && availability !== "checking") {
      mounted.modelView = {
        status: composerAdapterState(mounted) === "ready" ? "error" : "waitingForAdapter",
        thinkingSelectionSupported: false,
        ...(availability ? { error: `${agent} runtime is ${availability}` } : {}),
      };
      mounted.permissionModeView = { status: "idle" };
      renderMounted(mounted);
      return;
    }
    mounted.modelView = {
      status: composerAdapterState(mounted) === "ready" ? "loading" : "waitingForAdapter",
      thinkingSelectionSupported: false,
    };
    mounted.permissionModeView = { status: "idle" };
    renderMounted(mounted);
    if (!composerClient(mounted)) return;
    const generation = controller.beginModelRequest(mounted.composer);
    let catalogRequest: MountedCatalogRequest | undefined;
    try {
      if (!requestModelControl || !requestHostId) {
        throw new Error("External configuration control is unavailable");
      }
      const client = modelClientForHostFrom(requestModelControl, requestHostId);
      if (!client) {
        throw new Error(`Renderer Model request manager is unavailable for Host ${requestHostId}`);
      }
      catalogRequest = { client, hostId: requestHostId, agent, generation };
      catalogRequests.set(mounted, catalogRequest);
      const inspection = await client.inspectHarness({
        harnessId: harnessIdSchema.parse(agent),
      });
      if (
        !isCurrentModelRequest(mounted, generation) ||
        controller.get(mounted.composer).agent !== agent ||
        mounted.hostId !== requestHostId ||
        modelControl !== requestModelControl ||
        modelClientForHostFrom(requestModelControl, requestHostId) !== client ||
        activeModelHostId(mounted.composer) !== requestHostId
      ) {
        return;
      }
      if (inspection.status !== "ready") throw new Error(inspection.error.message);
      const current = controller.get(mounted.composer);
      const previousModel = controller.modelForAgent(mounted.composer, agent);
      const previousModelAvailable =
        previousModel !== undefined &&
        catalogModelForRef(inspection.catalog, previousModel) !== undefined;
      const preferredConfiguration =
        current.phase === "draft" && !previousModelAvailable
          ? readNewThreadExternalConfigurationPreference(
              agent,
              inspection.catalog,
              inspection.permissionModes,
              rendererNewThreadPreferenceStorage(mounted.hostId),
            )
          : undefined;
      const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
      const permissionModeLock = permissionModeSelectionLocked({
        phase: current.phase,
        permissionModeScope: inspection.capabilities.configuration.permissionModeScope,
      })
        ? {
            selectionLocked: true as const,
            selectionLockedReason: rendererHarnessMessages(settingsLifecycle.locale)
              .permissionModeFixedAtCreate,
          }
        : {};
      let selectedPermissionModeId: HarnessPermissionModeId | undefined;
      if (inspection.capabilities.configuration.selectPermissionMode) {
        const permissionModes = inspection.permissionModes;
        if (!permissionModes) {
          throw new Error("External Harness omitted its Permission Mode catalog");
        }
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          ...permissionModeLock,
        };
        const restoredPermissionModeId =
          current.phase === "locked"
            ? lockedPermissionMode(
                permissionModes,
                mounted.threadConfiguration?.effectivePermissionModeId,
                previousPermissionModeId,
              )
            : undefined;
        const preferredPermissionModeId =
          preferredConfiguration?.permissionModeId ??
          (agent === "claude-code" && mounted.hostId === "local"
            ? readClaudePermissionModePreference(permissionModes)
            : undefined);
        selectedPermissionModeId = draftPermissionMode(
          permissionModes,
          restoredPermissionModeId ?? previousPermissionModeId ?? preferredPermissionModeId,
        );
        mounted.permissionModeView = {
          status: "loading",
          catalog: permissionModes,
          selected: selectedPermissionModeId,
          ...permissionModeLock,
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
            ...permissionModeLock,
          };
        }
        return;
      }
      if (current.phase === "locked" && previousModel && !previousModelAvailable) {
        mounted.modelView = {
          status: "error",
          catalog: inspection.catalog,
          selected: previousModel,
          thinkingSelectionSupported: inspection.capabilities.configuration.selectThinkingOption,
          error: "Existing Thread Model is absent from the current Catalog",
        };
        if (selectedPermissionModeId && mounted.permissionModeView.catalog) {
          mounted.permissionModeView = {
            status: "ready",
            catalog: mounted.permissionModeView.catalog,
            selected: selectedPermissionModeId,
            ...permissionModeLock,
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
          await clearDraftPrewarm(mounted.composer);
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
          ...permissionModeLock,
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
      if (catalogRequest && catalogRequests.get(mounted) === catalogRequest) {
        catalogRequests.delete(mounted);
      }
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectExternalModel = async (mounted: MountedComposer, modelId: string): Promise<void> => {
    controller.clearPendingSubmission(mounted.composer);
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.modelView.catalog;
    const entry = catalog?.models.find(
      (model) => model.ref.id === modelId || model.fastModel?.id === modelId,
    );
    const selected = entry?.ref.id === modelId ? entry.ref : entry?.fastModel;
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
          await clearDraftPrewarm(mounted.composer);
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
        const client = composerClient(mounted);
        if (!client) throw new Error("Thread Host is unavailable");
        const state = await client.selectThreadModel({ threadId, model: selected });
        if (composerClient(mounted) !== client) return;
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
        if (!catalogModelForRef(catalog, effectiveModel)) {
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
          rendererNewThreadPreferenceStorage(mounted.hostId),
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
    if (
      !catalog ||
      !selectedPermissionModeId ||
      !model ||
      !modelControl ||
      mounted.permissionModeView.selectionLocked
    ) {
      return;
    }
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
          await clearDraftPrewarm(mounted.composer);
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
        const client = composerClient(mounted);
        if (!client) throw new Error("Thread Host is unavailable");
        const state = await client.selectThreadPermissionMode({
          threadId,
          permissionModeId: selectedPermissionModeId,
        });
        if (composerClient(mounted) !== client) return;
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
          rendererNewThreadPreferenceStorage(mounted.hostId),
        );
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
        selectionRejected: true,
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
    const catalogModel = catalogModelForRef(catalog, model);
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
          await clearDraftPrewarm(mounted.composer);
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
        const client = composerClient(mounted);
        if (!client) throw new Error("Thread Host is unavailable");
        const state = await client.selectThreadThinking({
          threadId,
          thinkingOptionId: selectedThinkingOptionId,
        });
        if (composerClient(mounted) !== client) return;
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
          rendererNewThreadPreferenceStorage(mounted.hostId),
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
    if (agent !== "codex" && composerAvailability(mounted)[agent] !== "ready") {
      return false;
    }
    controller.clearPendingSubmission(mounted.composer);
    const composerId = controller.get(mounted.composer).composerId;
    controller.invalidateModelRequests(mounted.composer);
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent: (nextAgent) => applyDraftAgentCarrier(mounted.composer, nextAgent),
      clearPrewarm: () => clearDraftPrewarm(mounted.composer),
    });
    renderMounted(mounted);
    try {
      const switched = await switching;
      if (switched && controller.get(mounted.composer).agent !== "codex") {
        void loadExternalCatalog(mounted);
      } else if (controller.get(mounted.composer).agent === "codex") {
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
        void refreshCommands(mounted);
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

  const loadCodexAccounts = async (): Promise<void> => {
    const hostIds = new Set([...mountedByComposer.values()].map((mounted) => mounted.hostId));
    await Promise.all(
      [...hostIds].map(async (hostId) => {
        const accounts = codexAccountsForHost(hostId);
        if (!accounts) return;
        await accounts.refresh();
        if (disposed || codexAccountsForHost(hostId) !== accounts) return;
        for (const mounted of mountedByComposer.values()) {
          if (mounted.hostId !== hostId) continue;
          renderMounted(mounted);
          void refreshDraftCodexUsage(mounted);
        }
      }),
    );
  };

  const openInstallPage = (hostId: string | null, agent: ExternalRendererAgent): void => {
    const plugin = hostId
      ? hostHarnessAvailabilityState(hostId).plugins?.find(({ id }) => id === agent)
      : undefined;
    const url =
      plugin?.links?.installation ?? plugin?.links?.documentation ?? plugin?.links?.website;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
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

  function modelClientForHostFrom(
    control: RendererModelClient | null,
    hostId: string | null,
  ): RendererModelClient | null {
    if (!control || !hostId) return null;
    if (control.clientForHost) return control.clientForHost(hostId);
    // Only legacy controls without Host identity are local. An explicit null
    // means unresolved ownership, never permission to send a local request.
    if (!control.currentHostId) return hostId === "local" ? control : null;
    return control.currentHostId() === hostId ? control : null;
  }

  function modelClientForHost(hostId: string): RendererModelClient | null {
    return modelClientForHostFrom(modelControl, hostId);
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
      // Disconnection invalidates outstanding observations even if no replacement
      // client exists yet. A late reply must not mark this Host ready again.
      if (state.request) {
        state.requestGeneration += 1;
        state.request = null;
      }
      if (force || [...mountedByComposer.values()].some((mounted) => mounted.hostId === hostId)) {
        for (const agent of Object.keys(state.availability)) {
          state.availability[agent] = "error";
          state.errors[agent] = {
            code: "unavailable",
            message: `Renderer connection is unavailable for Host ${hostId}`,
            retryable: true,
            stage: "request",
          };
          state.webUi[agent] = false;
        }
        publishConnectionStatus();
        if (hostId === activeAvailabilityHostId) {
          for (const mounted of mountedByComposer.values()) renderMounted(mounted);
        }
      }
      scheduleHarnessAvailabilityRetry(hostId);
      return Promise.resolve();
    }
    if (state.request?.client === client) return state.request.promise;
    if (state.directoryClient !== client) {
      state.plugins = null;
      state.availability = {};
      state.errors = {};
      state.webUi = {};
      state.directoryClient = client;
    }
    const generation = ++state.requestGeneration;
    const promise = (async () => {
      if (!state.plugins || force) {
        try {
          if (!client.listHarnessPlugins)
            throw new Error("This Host does not support Harness plugin discovery");
          const { plugins } = await client.listHarnessPlugins();
          if (
            disposed ||
            generation !== state.requestGeneration ||
            modelClientForHost(hostId) !== client
          )
            return;
          state.plugins = plugins.filter(
            ({ id, kind }) =>
              kind !== "usage" && (!options.enabledAgents || options.enabledAgents.includes(id)),
          );
          delete state.directoryError;
          state.availability = Object.fromEntries(
            state.plugins.map(({ id }) => [id, state.availability[id] ?? "checking"]),
          );
          enabledAgents.splice(
            0,
            enabledAgents.length,
            "codex",
            ...new Set(
              [...harnessAvailabilityByHost.values()].flatMap(
                ({ plugins }) => plugins?.map(({ id }) => id) ?? [],
              ),
            ),
          );
          controller.setEnabledAgents(enabledAgents);
          sidebarAgentIcons.refresh();
          for (const mounted of mountedByComposer.values()) {
            if (mounted.hostId === hostId || hostId === "local") renderMounted(mounted);
          }
          publishConnectionStatus();
        } catch (error) {
          if (
            disposed ||
            generation !== state.requestGeneration ||
            modelClientForHost(hostId) !== client
          )
            return;
          state.directoryError = error instanceof Error ? error.message : String(error);
          publishConnectionStatus();
          scheduleHarnessAvailabilityRetry(hostId);
          return;
        }
      }
      const agentsToInspect = force
        ? state.plugins.map(({ id }) => id)
        : passiveHarnessAvailabilityAgents(state.availability, state.errors);
      await Promise.all(
        agentsToInspect.map(async (agent) => {
          let status: RendererAgentAvailability = "error";
          let nextError: CodexhostError | undefined;
          let webUiAvailable = false;
          try {
            // Bulk discovery must not occupy the native interactive slots needed
            // to identify the visible Thread and load its selected configuration.
            const inspection = await client.inspectHarness(
              { harnessId: harnessIdSchema.parse(agent), refresh },
              { priority: "background" },
            );
            status = inspection.status === "ready" ? "ready" : inspection.status;
            webUiAvailable =
              hostId === "local" &&
              inspection.status === "ready" &&
              inspection.webUi?.open === true;
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
              code:
                error instanceof RendererMethodUnavailableError ? "unavailable" : "internalError",
              message: error instanceof Error ? error.message : String(error),
              retryable: !(error instanceof RendererMethodUnavailableError),
              stage: "request",
            };
          }
          if (
            generation !== state.requestGeneration ||
            disposed ||
            modelClientForHost(hostId) !== client
          )
            return;
          const previousStatus = state.availability[agent];
          state.errors[agent] = nextError;
          state.availability = { ...state.availability, [agent]: status };
          state.webUi = { ...state.webUi, [agent]: webUiAvailable };
          for (const mounted of mountedByComposer.values()) {
            if (mounted.hostId !== hostId) continue;
            const composerState = controller.get(mounted.composer);
            const pendingCatalog = catalogRequests.get(mounted);
            const loadingCurrentCatalog =
              pendingCatalog?.client === client &&
              pendingCatalog.hostId === hostId &&
              pendingCatalog.agent === agent &&
              isCurrentModelRequest(mounted, pendingCatalog.generation);
            if (
              composerState.agent === agent &&
              (status !== "ready" || !loadingCurrentCatalog || (refresh && force)) &&
              shouldReloadExternalCatalogAfterAvailabilityRefresh(
                previousStatus,
                status,
                isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView),
                refresh && force,
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

  const reloadMountedOwnershipForHost = (): void => {
    let changed = false;
    for (const mounted of mountedByComposer.values()) {
      const hostId = activeModelHostId(mounted.composer);
      if (!hostId || mounted.hostId === hostId) continue;
      changed = true;
      if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
        controller.clearPendingSubmission(mounted.composer);
        controller.beginModelRequest(mounted.composer);
        controller.clearConfiguration(mounted.composer);
        mounted.hostId = hostId;
        mounted.modelView = { status: "idle" };
        mounted.permissionModeView = { status: "idle" };
        mounted.usage = null;
        mounted.accountCredits = null;
        mounted.usageRequestGeneration += 1;
        const state = controller.get(mounted.composer);
        if (applyDraftAgentCarrier(mounted.composer, state.agent)) {
          void clearDraftPrewarm(mounted.composer).catch(() => undefined);
        }
        void loadExternalCatalog(mounted);
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
    if (changed) sidebarAgentIcons.refresh();
  };

  function reconcileHarnessAvailabilityHost(): void {
    // Settings lists observed Hosts even when multiple Composers make the
    // active route ambiguous. Requests still resolve each Host independently.
    for (const hostId of modelControl?.knownHostIds?.() ?? []) {
      hostHarnessAvailabilityState(hostId);
    }
    // Hidden/native Composers can belong to a different Host. Never rebind
    // every Thread to the globally selected Host when navigating between them.
    reloadMountedOwnershipForHost();
    let connectionsChanged = false;
    for (const target of new Set([...mountedByComposer.values()].map((m) => m.hostId))) {
      if (!target) continue;
      const client = modelClientForHost(target);
      const previous = usageSubscriptions.get(target);
      if (previous?.client === client) continue;
      connectionsChanged ||= previous !== undefined;
      previous?.dispose();
      usageSubscriptions.delete(target);
      if (!client?.subscribeThreadUsage) continue;
      try {
        const dispose = client.subscribeThreadUsage((update) => {
          if (usageSubscriptions.get(target)?.client !== client) return;
          if (modelClientForHost(target) !== client) return;
          applyThreadUsageUpdate(target, update);
        });
        usageSubscriptions.set(target, { client, dispose });
        connectionsChanged = true;
      } catch {
        // A missing notification channel must not block request-based usage reads.
      }
    }
    // A reconnect can replace the client without changing the Composer's Host ID.
    if (connectionsChanged) sidebarAgentIcons.refresh();
    const hostId = activeModelHostId();
    if (
      !hostId ||
      (hostId === activeAvailabilityHostId &&
        [...mountedByComposer.values()].every((mounted) => mounted.hostId !== null))
    )
      return;
    // The first Composer can mount before the route is ready. The availability
    // cache starts at "local", but that does not establish the Composer's Host.
    activeAvailabilityHostId = hostId;
    hostHarnessAvailabilityState(hostId);
    publishConnectionStatus();
    for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    void refreshHarnessAvailabilityForHost(hostId);
  }

  const refreshHarnessAvailability = async (refresh = false): Promise<void> => {
    reconcileHarnessAvailabilityHost();
    const hostIds = new Set([activeAvailabilityHostId]);
    for (const mounted of mountedByComposer.values()) {
      if (mounted.hostId) hostIds.add(mounted.hostId);
    }
    await Promise.all(
      [...hostIds].map((hostId) => refreshHarnessAvailabilityForHost(hostId, refresh)),
    );
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
            ...(state.directoryError ? { directoryError: state.directoryError } : {}),
            agents: (state.plugins ?? EMPTY_PLUGINS).map((plugin) => ({
              agent: plugin.id,
              plugin: pluginForHost(hostId, plugin.id) ?? plugin,
              availability: state.availability[plugin.id] ?? "checking",
              error: state.errors[plugin.id] ?? null,
              ...(state.webUi[plugin.id] ? { webUiAvailable: true as const } : {}),
            })),
          };
        }),
      };
    },
    refresh(hostId?: string): Promise<void> {
      if (hostId !== undefined) {
        return refreshConnectionHosts(
          [hostId],
          (target) => refreshHarnessAvailabilityForHost(target, true, false, true),
          (target) => hostHarnessAvailabilityState(target).request?.promise,
        );
      }
      reconcileHarnessAvailabilityHost();
      return refreshConnectionHosts(harnessAvailabilityByHost.keys(), (target) =>
        refreshHarnessAvailabilityForHost(target, true, false, true),
      );
    },
    async installation(hostId, agent, action) {
      const client = modelClientForHost(hostId);
      if (!client?.installation)
        throw new Error("Harness version management is unavailable on this Host");
      return client.installation({ harnessId: harnessIdSchema.parse(agent), action });
    },
    async getLaunchSettings(hostId, agent) {
      const client = hostId === "local" ? modelClientForHost(hostId) : null;
      if (!client?.getHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.getHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent) });
    },
    async setLaunchSettings(hostId, agent, path) {
      const client = hostId === "local" ? modelClientForHost(hostId) : null;
      if (!client?.setHarnessLaunchSettings) throw new Error("Launch settings are unavailable");
      return client.setHarnessLaunchSettings({ harnessId: harnessIdSchema.parse(agent), path });
    },
    async openWebUi(hostId: string, agent: ExternalRendererAgent): Promise<void> {
      const state = hostHarnessAvailabilityState(hostId);
      const client = hostId === "local" ? modelClientForHost(hostId) : null;
      if (
        state.availability[agent] !== "ready" ||
        state.webUi[agent] !== true ||
        !client?.openHarnessWebUi
      ) {
        throw new Error("Harness Web UI is unavailable");
      }
      try {
        await client.openHarnessWebUi({ harnessId: harnessIdSchema.parse(agent) });
      } catch (error) {
        state.webUi = { ...state.webUi, [agent]: false };
        publishConnectionStatus();
        void refreshHarnessAvailabilityForHost(hostId, true, false, true).catch(() => undefined);
        throw error;
      }
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
      isOrbitComposer(composer) ||
      !composer.matches(CODEX_COMPOSER_SELECTOR)
    ) {
      return;
    }
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const modelTarget = findComposerModelTarget(composer);
    const hostId = activeModelHostId(composer);
    const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
    if (!editor) return;
    const state = controller.mount(
      composer,
      controllerTarget(modelTarget, hostId),
      modelTarget?.[0] === "default"
        ? (readNewThreadAgentPreference(undefined, rendererNewThreadPreferenceStorage(hostId)) ??
            options.defaultAgent ??
            "codex")
        : undefined,
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
      (agent) => openInstallPage(activeModelHostId(composer), agent),
      () => {
        void loadCodexAccounts();
      },
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
      () => {
        // The button is the discoverable entry to the `#` menu.
        const editor = composer.querySelector<HTMLElement>(EDITOR_SELECTOR);
        if (editor) delegationMention?.openFor(editor);
      },
    );
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      codexUsageGate: createRendererCodexUsageGate(composer),
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
      commandRequestGeneration: 0,
    };
    mountedByComposer.set(composer, mounted);
    if (isComposerModelWriteAllowed(modelTarget)) {
      applyDraftAgentCarrier(composer, state.agent);
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
    } else if (
      state.agent !== "codex" &&
      !isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView)
    ) {
      void loadExternalCatalog(mounted);
    }
    if (!threadIdFromComposerModelTarget(modelTarget)) void refreshDraftCodexUsage(mounted);
    void refreshCommands(mounted);
  };

  const scan = (): void => {
    scanScheduled = false;
    const refreshTargets = refreshTargetsOnNextScan;
    refreshTargetsOnNextScan = false;
    if (disposed) return;
    settingsLifecycle.refresh();
    const transferredComposers = new Set<Element>();
    for (const [target, replacement] of pendingReplacements) {
      const sourceState = controller.get(replacement.source.composer);
      const replacementTarget = findComposerModelTarget(target);
      const replacementHostId = activeModelHostId(target);
      if (
        isOrbitComposer(target) ||
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
      } else {
        transferredComposers.add(replacement.source.composer);
      }
    }
    for (const [composer, mounted] of mountedByComposer) {
      if (
        !composer.isConnected ||
        isOrbitComposer(composer) ||
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
        mounted.codexUsageGate.dispose();
        disposeComposerAgentControl(mounted.control);
        mountedByComposer.delete(composer);
        controller.detach(composer, transferredComposers.has(composer));
        continue;
      }
      const state = controller.get(composer);
      const hideCodexControls = controller.isSwitching(composer) || state.agent !== "codex";
      reconcileComposerNativeControls(mounted.control, hideCodexControls, hideCodexControls);
      if (refreshTargets) refreshMountedConversationTarget(mounted);
      showCodexUsageGateStatus(mounted, mounted.codexUsageGate.refresh());
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mount(composer);
    }
    const localState = hostHarnessAvailabilityState("local");
    if (
      (!localState.plugins && !localState.directoryError) ||
      Object.values(localState.availability).includes("checking")
    ) {
      void refreshHarnessAvailabilityForHost("local");
    }
    reconcileHarnessAvailabilityHost();
    if (
      [...mountedByComposer.values()].some(
        (mounted) =>
          (mounted.hostId !== null &&
            !hostHarnessAvailabilityState(mounted.hostId).plugins &&
            !hostHarnessAvailabilityState(mounted.hostId).directoryError) ||
          Object.values(composerAvailability(mounted)).includes("checking"),
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
    requestAnimationFrame(scan);
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
    if (!isMountedComposer(composer)) return false;
    const state = controller.get(composer);
    const mounted = mountedByComposer.get(composer);
    if (mounted?.modelTarget?.[0] === "conversation") {
      return state.phase === "locked" && mounted.ownershipStatus === "ready";
    }
    if (!mounted || !isComposerModelWriteAllowed(mounted.modelTarget)) return false;
    return applyComposerModelWrite(mounted.modelTarget, () =>
      applyDraftAgentCarrier(composer, state.agent),
    );
  };
  const blockEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const prepareComposer = (composer: Element): boolean | null => {
    const mounted = mountedByComposer.get(composer);
    if (!mounted) return null;
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
    if (!composer || !mounted || refreshSendButton(mounted.control) !== button) return;
    if (!prepareComposer(composer)) {
      blockEvent(event);
      return;
    }
    notifySubmission(composer, "click");
  };

  const mutationObserver = new MutationObserver((mutations) => {
    const relevant = mutations.filter(mutationMayAffectComposer);
    if (relevant.length === 0) return;
    transferReplacedComposers(relevant);
    scheduleScan(relevant.some(mutationMayChangeComposerTarget));
  });
  const onHostRouteChange = (): void => {
    // Reapply each draft's selection after its native connection changes.
    // Do this before rebinding Hosts: an old local draft is not a remote choice.
    for (const mounted of mountedByComposer.values()) {
      const hostId = activeModelHostId(mounted.composer);
      if (
        hostId &&
        mounted.hostId === hostId &&
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        controller.get(mounted.composer).agent !== "codex" &&
        !controller.isSwitching(mounted.composer) &&
        isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView)
      ) {
        applyComposerAgent(mounted.composer);
      }
    }
    sidebarAgentIcons.refresh();
    reconcileHarnessAvailabilityHost();
    void loadCodexAccounts();
    void refreshHarnessAvailability();
    for (const mounted of mountedByComposer.values()) {
      const state = controller.get(mounted.composer);
      if (
        state.agent !== "codex" &&
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        !isExternalConfigurationStable(mounted.modelView, mounted.permissionModeView)
      ) {
        void loadExternalCatalog(mounted);
      }
    }
  };
  const onAdapterStatus = () => {
    publishConnectionStatus();
    if (shouldRefreshCodexAccountsForAdapterState(adapterStatus.state)) {
      void loadCodexAccounts();
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      void refreshHarnessAvailability();
    }
    for (const mounted of mountedByComposer.values()) {
      if (
        mounted.modelView.status === "waitingForAdapter" &&
        mounted.composer.isConnected &&
        composerClient(mounted)
      ) {
        applyComposerAgent(mounted.composer);
        void loadExternalCatalog(mounted);
      }
      renderMounted(mounted);
    }
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
    void loadCodexAccounts();
    for (const mounted of mountedByComposer.values()) {
      if (
        mounted.hostId === activeModelHostId(mounted.composer) &&
        mounted.ownershipStatus === "error"
      ) {
        void loadThreadOwnership(mounted);
      }
    }
    const local = hostHarnessAvailabilityState("local");
    if (!local.plugins || Object.values(local.availability).some((status) => status !== "ready")) {
      void refreshHarnessAvailabilityForHost("local", true);
    }
    if (
      [...mountedByComposer.values()].some((mounted) =>
        Object.values(composerAvailability(mounted)).some((status) => status !== "ready"),
      )
    ) {
      void refreshHarnessAvailability(true);
    }
  };
  const onDraftWorkspace = (event: Event): void => {
    const detail: unknown = (event as CustomEvent).detail;
    if (typeof detail !== "object" || detail === null) return;
    const { hostId, cwd } = detail as { hostId?: unknown; cwd?: unknown };
    if (typeof hostId !== "string" || typeof cwd !== "string" || cwd.length === 0) return;
    draftWorkspaces.set(hostId, cwd);
    for (const mounted of mountedByComposer.values()) {
      if (
        !threadIdFromComposerModelTarget(mounted.modelTarget) &&
        activeModelHostId(mounted.composer) === hostId &&
        controller.get(mounted.composer).agent !== "codex"
      ) {
        void refreshCommands(mounted, { keepCurrent: true });
      }
    }
  };
  window.addEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
  window.addEventListener("codexhost:draft-workspace", onDraftWorkspace);
  window.addEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
  window.addEventListener("focus", onWindowFocus);
  delegationMention = installRendererDelegationMention(document, {
    onOpen: (editor) => {
      const composer = composerForElement(editor);
      const mounted = composer ? mountedByComposer.get(composer) : undefined;
      if (mounted && controller.get(mounted.composer).agent !== "codex") {
        void refreshCommands(mounted, { keepCurrent: true });
      }
    },
    readTargets: (editor) => {
      const composer = composerForElement(editor);
      const mounted = composer ? mountedByComposer.get(composer) : undefined;
      const availability = mounted ? composerAvailability(mounted) : {};
      return enabledAgents
        .filter((agent) => agent === "codex" || availability[agent] === "ready")
        .map((agent) => {
          const plugin = mounted?.hostId ? pluginForHost(mounted.hostId, agent) : undefined;
          return { agent, label: rendererAgentLabel(agent, plugin), ...(plugin ? { plugin } : {}) };
        });
    },
    isComposerEditor: (editor) => {
      const composer = composerForElement(editor);
      return composer !== null && isMountedComposer(composer);
    },
    readLocale: () => settingsLifecycle.locale,
    // Desktop's own suggestion menu hugs the input card and covers the
    // top tray (workspace / branch bar), so anchor to the card when present.
    anchorForEditor: (editor) =>
      editor.closest("[data-composer-body]") ?? composerForElement(editor),
    readCommands: (editor) => {
      const composer = composerForElement(editor);
      const mounted = composer ? mountedByComposer.get(composer) : undefined;
      if (!mounted || controller.get(mounted.composer).agent === "codex") return null;
      const { commands, hasSession, executingCommandId, source } =
        mounted.control.harnessCommands.snapshot();
      // While a command runs, the ⌘ button is disabled too.
      if (executingCommandId !== null) return null;
      const messages = rendererHarnessMessages(settingsLifecycle.locale);
      const agent = controller.get(mounted.composer).agent;
      const pendingNotice =
        source === "static"
          ? rendererLiveCommandsPendingNotice(
              settingsLifecycle.locale,
              rendererAgentLabel(
                agent,
                mounted.hostId
                  ? hostHarnessAvailabilityState(mounted.hostId).plugins?.find(
                      ({ id }) => id === agent,
                    )
                  : undefined,
              ),
            )
          : null;
      if (commands.length === 0 && pendingNotice === null) return null;
      return {
        commands,
        pendingNotice,
        disabledReason: (command) =>
          !hasSession && rendererHarnessCommandExecutesDirectly(command)
            ? messages.commandRequiresConversation
            : null,
        select: (command) => selectCommand(mounted, command),
      };
    },
  });

  const connectedComposers = (): MountedComposer[] =>
    [...mountedByComposer.values()].filter(
      (mounted) => isMountedComposer(mounted.composer) && mounted.control.root.isConnected,
    );

  const api: RendererBindingProbeApi = {
    remoteConnections: (request) => handleRemoteConnectionsRequest(remoteConnections, request),
    currentThreadId() {
      const mounted = connectedComposers();
      return mounted.length === 1 && mounted[0]
        ? (threadIdFromComposerModelTarget(mounted[0].modelTarget) ?? null)
        : null;
    },
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
    setAdapter(status, dispose, applyAgent, nextModelControl) {
      usageNotificationDispose();
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      modelControl = nextModelControl ?? null;
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
        state.codexAccounts?.dispose();
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      activeAvailabilityHostId = "local";
      sidebarAgentIcons.refresh();
      void refreshHarnessAvailabilityForHost("local");
      reconcileHarnessAvailabilityHost();
      void loadCodexAccounts();
      const connected = connectedComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) {
          const state = controller.get(mounted.composer);
          if (!threadIdFromComposerModelTarget(mounted.modelTarget)) {
            mounted.hostId = activeModelHostId(mounted.composer);
          }
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
      for (const mounted of mountedByComposer.values()) {
        renderMounted(mounted);
        void refreshCommands(mounted);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      usageNotificationDispose();
      adapterDispose?.();
      adapterDispose = null;
      applyAdapterAgent = null;
      modelControl = null;
      mutationObserver.disconnect();
      disposeReasoningSoftWrap();
      delegationMention?.dispose();
      sidebarAgentIcons.dispose();
      settingsLifecycle.dispose();
      document.removeEventListener("beforeinput", onBeforeInput, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("codexhost:draft-prewarm-policy-changed", onHostRouteChange);
      window.removeEventListener("codexhost:draft-workspace", onDraftWorkspace);
      window.removeEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
      window.removeEventListener("focus", onWindowFocus);
      for (const state of harnessAvailabilityByHost.values()) {
        state.requestGeneration += 1;
        state.codexAccounts?.dispose();
        if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
      }
      harnessAvailabilityByHost.clear();
      for (const timer of usageRefreshTimers.values()) window.clearTimeout(timer);
      usageRefreshTimers.clear();
      for (const mounted of mountedByComposer.values()) {
        mounted.usageRequestGeneration += 1;
        usageRefreshAttempts.delete(mounted.composer);
        mounted.codexUsageGate.dispose();
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
