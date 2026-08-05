import {
  harnessIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
  type HarnessPermissionModeCatalog,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type ThreadInspection,
} from "@codexhost/shared-contracts";

import {
  DEFAULT_RENDERER_AGENTS,
  DraftAgentController,
  type ComposerAgentPhase,
  type RendererAgent,
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
  renderComposerAgentControl,
  sendButtonWithin,
  type ComposerAgentControl,
  type ExternalModelControlView,
  type ExternalPermissionModeControlView,
} from "./renderer-composer-dom.js";
import {
  decodeClaudeTransportModelId,
  findComposerModelTarget,
  isDraftPrewarmPolicyReady,
  isPiTransportModelId,
  threadIdFromComposerModelTarget,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import {
  readClaudePermissionModePreference,
  writeClaudePermissionModePreference,
} from "./renderer-permission-mode-preference.js";
import { isPermissionModeControlReady } from "./renderer-permission-mode-picker.js";
import { installRendererSidebarAgentIcons } from "./renderer-sidebar-agent-icons.js";
import { installRendererSettingsLifecycle } from "./renderer-settings-lifecycle.js";

const externalHarnessIds = {
  pi: harnessIdSchema.parse("pi"),
  "claude-code": harnessIdSchema.parse("claude-code"),
} as const;

export interface RendererBindingProbeStatus {
  version: 2;
  mountedComposers: number;
  enabledAgents: RendererAgent[];
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

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  if (inspection.harnessId === "pi") {
    if (!isPiTransportModelId(inspection.transportModelId)) {
      throw new Error("Pi Thread reported an incompatible transport Model");
    }
    const piThinkingOptionId = selectableThinkingOptionId(inspection);
    return {
      agent: "pi",
      ...(inspection.effectiveModel ? { model: inspection.effectiveModel } : {}),
      ...(piThinkingOptionId ? { thinkingOptionId: piThinkingOptionId } : {}),
      ...(inspection.effectivePermissionModeId
        ? { permissionModeId: inspection.effectivePermissionModeId }
        : {}),
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
): boolean {
  if (!sourceTarget || !replacementTarget) return false;
  if (sourceTarget === replacementTarget) return true;
  return (
    sourcePhase === "locked" &&
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
): "none" | "transfer" | "inspect" {
  if (!isLateConversationTarget(mountedTarget, currentTarget)) return "none";
  return mountedTarget?.[0] === "default" && sourcePhase === "locked" ? "transfer" : "inspect";
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
  const sidebarAgentIcons = installRendererSidebarAgentIcons({
    getClient: () => modelControl,
  });
  const settingsLifecycle = installRendererSettingsLifecycle();
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    modelUpdates: 0,
    hook: null,
  };

  const isCurrentModelRequest = (mounted: MountedComposer, generation: number): boolean =>
    mounted.composer.isConnected &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentModelRequest(mounted.composer, generation);

  const isCurrentOwnershipRequest = (mounted: MountedComposer, generation: number): boolean =>
    mounted.composer.isConnected &&
    mountedByComposer.get(mounted.composer) === mounted &&
    controller.isCurrentOwnershipRequest(mounted.composer, generation);

  const notifySubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const state = controller.recordSubmission(composer);
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
      mounted.modelView,
      mounted.permissionModeView,
    );
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
    const policy = window.__codexhostDraftPrewarmPolicyV1;
    if (!isDraftPrewarmPolicyReady(policy)) {
      throw new Error("Renderer draft prewarm policy is unavailable");
    }
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
    const generation = controller.beginOwnershipRequest(mounted.composer);
    mounted.ownershipStatus = "loading";
    renderMounted(mounted);
    try {
      if (!modelControl) throw new Error("Thread ownership control is unavailable");
      const inspection = await modelControl.inspectThread({ threadId });
      if (
        !isCurrentOwnershipRequest(mounted, generation) ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId
      ) {
        return;
      }
      const { agent, model, thinkingOptionId, permissionModeId } =
        restoredThreadOwnership(inspection);
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
      }
    }
  };

  const refreshMountedConversationTarget = (mounted: MountedComposer): boolean => {
    const currentTarget = findComposerModelTarget(mounted.composer);
    const resolution = lateConversationTargetResolution(
      mounted.modelTarget,
      currentTarget,
      controller.get(mounted.composer).phase,
    );
    if (resolution === "none") return false;

    const previousTarget = mounted.modelTarget;
    mounted.modelTarget = currentTarget;
    const rebound =
      resolution === "transfer"
        ? controller.transfer(mounted.composer, mounted.composer, currentTarget)
        : controller.rebindConversation(mounted.composer, currentTarget) !== null;
    if (!rebound) {
      mounted.ownershipStatus = "error";
      renderMounted(mounted);
      return true;
    }
    if (resolution === "transfer") {
      mounted.ownershipStatus = "ready";
      renderMounted(mounted);
    } else {
      mounted.composerId = controller.get(mounted.composer).composerId;
      mounted.modelView = { status: "idle" };
      mounted.permissionModeView = { status: "idle" };
      mounted.threadConfiguration = undefined;
      mounted.ownershipStatus = "loading";
      if (previousTarget?.[0] === "conversation") renderMounted(mounted);
      void loadThreadOwnership(mounted);
    }
    return true;
  };

  const loadExternalCatalog = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
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
          agent === "claude-code" ? readClaudePermissionModePreference(permissionModes) : undefined;
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

      const previousModel = controller.modelForAgent(mounted.composer, agent);
      const previousModelAvailable =
        previousModel !== undefined &&
        inspection.catalog.models.some((model) => model.ref.id === previousModel.id);
      if (current.phase === "locked" && previousModel && !previousModelAvailable) {
        throw new Error("Existing Thread Model is absent from the current Catalog");
      }
      const selected = previousModelAvailable ? previousModel : inspection.catalog.defaultModel;
      if (!selected) throw new Error("External Harness did not report its default Model");
      const effectiveCatalog =
        current.phase === "locked" && mounted.threadConfiguration
          ? catalogWithConfigurationState(inspection.catalog, selected, mounted.threadConfiguration)
          : inspection.catalog;
      const previousThinkingOptionId = controller.thinkingOptionForAgent(mounted.composer, agent);
      const selectedThinkingOptionId = inspection.capabilities.configuration.selectThinkingOption
        ? draftThinkingOptionForModel(effectiveCatalog, selected, previousThinkingOptionId)
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
      if (selectedThinkingOptionId) {
        controller.setExternalThinkingOption(mounted.composer, agent, selectedThinkingOptionId);
      }
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
      if (effectiveThinkingOptionId) {
        controller.setExternalThinkingOption(mounted.composer, agent, effectiveThinkingOptionId);
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
    const current = controller.get(mounted.composer);
    if (current.agent === "codex") return;
    const agent = current.agent;
    const catalog = mounted.permissionModeView.catalog;
    const selectedPermissionModeId = catalog?.modes.find(({ id }) => id === permissionModeId)?.id;
    const model = controller.modelForAgent(mounted.composer, agent);
    if (!catalog || !selectedPermissionModeId || !model || !modelControl) return;
    const previousPermissionModeId = controller.permissionModeForAgent(mounted.composer, agent);
    if (agent === "claude-code") {
      writeClaudePermissionModePreference(selectedPermissionModeId);
    }
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
    const composerId = controller.get(mounted.composer).composerId;
    controller.invalidateModelRequests(mounted.composer);
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent(nextAgent) {
        return (
          applyAdapterAgent?.(
            nextAgent,
            controller.modelForAgent(mounted.composer, nextAgent),
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

  const mount = (composer: Element): void => {
    if (mountedByComposer.has(composer) || !composer.isConnected) return;
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const modelTarget = findComposerModelTarget(composer);
    const state = controller.mount(composer, modelTarget);
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
    };
    mountedByComposer.set(composer, mounted);
    if (isComposerModelWriteAllowed(modelTarget)) {
      applyAdapterAgent?.(
        state.agent,
        controller.modelForAgent(composer, state.agent),
        state.agent !== "codex"
          ? controller.thinkingOptionForAgent(composer, state.agent)
          : undefined,
        state.agent !== "codex"
          ? controller.permissionModeForAgent(composer, state.agent)
          : undefined,
        composer,
      );
    }
    renderMounted(mounted);
    if (threadIdFromComposerModelTarget(modelTarget) && !inherited) {
      void loadThreadOwnership(mounted);
    } else if (state.agent !== "codex" && !isExternalConfigurationReady(mounted)) {
      void loadExternalCatalog(mounted);
    }
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
      if (
        !shouldTransferComposerState(
          replacement.sourceModelTarget,
          replacementTarget,
          sourceState.phase,
        ) ||
        !controller.transfer(replacement.source.composer, target, replacementTarget)
      ) {
        pendingReplacements.delete(target);
      }
    }
    for (const [composer, mounted] of mountedByComposer) {
      if (!composer.isConnected || !mounted.control.root.isConnected) {
        disposeComposerAgentControl(mounted.control);
        mountedByComposer.delete(composer);
        continue;
      }
      if (refreshTargets) refreshMountedConversationTarget(mounted);
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mount(composer);
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
    return applyComposerModelWrite(
      mounted.modelTarget,
      () =>
        applyAdapterAgent?.(
          state.agent,
          controller.modelForAgent(composer, state.agent),
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
    controller.lock(composer);
    renderMounted(mounted);
    return true;
  };
  const composerForTarget = (target: EventTarget | null): Element | null => {
    const element = eventElement(target);
    const editor = element ? editorForElement(element) : null;
    return editor ? composerForEditor(editor) : null;
  };
  const onBeforeInput = (event: InputEvent): void => {
    const composer = composerForTarget(event.target);
    if (!composer) return;
    const mounted = mountedByComposer.get(composer);
    if (mounted && isOwnershipSubmissionBlocked(mounted.ownershipStatus)) return;
    if (controller.isSwitching(composer) || !applyComposerAgent(composer)) blockEvent(event);
  };
  const onSubmit = (event: Event): void => {
    const element = eventElement(event.target);
    const composer = element ? composerForElement(element) : null;
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
    const composer = composerForElement(button);
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
  const onAdapterStatus = () => {
    if (adapterStatus.state === "ready") {
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
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("codexhost:renderer-adapter-status", onAdapterStatus);

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
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      modelControl = nextModelControl ?? null;
      adapterStatus = status;
      sidebarAgentIcons.refresh();
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
      window.removeEventListener("codexhost:renderer-adapter-status", onAdapterStatus);
      for (const mounted of mountedByComposer.values())
        disposeComposerAgentControl(mounted.control);
      mountedByComposer.clear();
      pendingReplacements.clear();
      delete window.__codexhostRendererBindingProbeV1;
    },
  };
  window.__codexhostRendererBindingProbeV1 = api;
  scan();
  return api;
}
