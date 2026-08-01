import {
  harnessIdSchema,
  type HarnessModelCatalog,
  type HarnessModelRef,
  type HarnessModelSelectionState,
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
} from "./renderer-composer-dom.js";
import {
  findComposerModelTarget,
  isClaudeTransportModelId,
  isDraftPrewarmPolicyReady,
  isPiTransportModelId,
  threadIdFromComposerModelTarget,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";
import { thinkingOptionsForModel } from "./renderer-model-picker.js";
import { installRendererSidebarAgentIcons } from "./renderer-sidebar-agent-icons.js";

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

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: (
      agent: RendererAgent,
      model?: HarnessModelRef,
      thinkingOptionId?: HarnessThinkingOptionId,
    ) => boolean,
    applyPiModel?: (model: HarnessModelRef, thinkingOptionId?: HarnessThinkingOptionId) => boolean,
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
    };
  }
  if (inspection.harnessId === "claude-code") {
    if (!isClaudeTransportModelId(inspection.transportModelId)) {
      throw new Error("Claude Code Thread reported an incompatible transport Model");
    }
    return {
      agent: "claude-code",
      ...(inspection.effectiveModel ? { model: inspection.effectiveModel } : {}),
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
  ownershipStatus: ComposerOwnershipStatus;
  threadConfiguration: HarnessModelSelectionState | undefined;
}

interface PendingComposerReplacement {
  source: Element;
  sourceModelTarget: readonly unknown[] | null;
  target: Element;
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
    (sourcePhase === "draft" || sourcePhase === "locked") &&
    sourceTarget[0] === "default" &&
    replacementTarget[0] === "conversation"
  );
}

export function isLateConversationTarget(
  mountedTarget: readonly unknown[] | null,
  currentTarget: readonly unknown[] | null,
): boolean {
  return mountedTarget?.[0] === "default" && currentTarget?.[0] === "conversation";
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
  let applyAdapterAgent:
    | ((
        agent: RendererAgent,
        model?: HarnessModelRef,
        thinkingOptionId?: HarnessThinkingOptionId,
      ) => boolean)
    | null = null;
  let applyAdapterPiModel:
    ((model: HarnessModelRef, thinkingOptionId?: HarnessThinkingOptionId) => boolean) | null = null;
  let modelControl: RendererModelClient | null = null;
  const sidebarAgentIcons = installRendererSidebarAgentIcons({
    getClient: () => modelControl,
  });
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    decoratedRequests: 0,
    modelUpdates: 0,
    candidateCount: 0,
    candidates: [],
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
    agent: Exclude<RendererAgent, "codex">,
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): boolean =>
    agent === "pi"
      ? (applyAdapterPiModel?.(model, thinkingOptionId) ?? false)
      : (applyAdapterAgent?.(agent, model) ?? false);

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
      const { agent, model, thinkingOptionId } = restoredThreadOwnership(inspection);
      const restored = controller.restore(mounted.composer, agent, model, thinkingOptionId);
      if (
        !restored ||
        !(applyAdapterAgent?.(agent, model, thinkingOptionId) ?? agent === "codex")
      ) {
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
        };
        mounted.modelView = { status: "loading" };
        void loadExternalCatalog(mounted);
      } else {
        mounted.threadConfiguration = undefined;
        mounted.modelView = { status: "idle" };
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
    if (!isLateConversationTarget(mounted.modelTarget, currentTarget)) return false;

    mounted.modelTarget = currentTarget;
    mounted.ownershipStatus = "loading";
    if (!controller.transfer(mounted.composer, mounted.composer, currentTarget)) {
      mounted.ownershipStatus = "error";
      renderMounted(mounted);
      return true;
    }
    renderMounted(mounted);
    void loadThreadOwnership(mounted);
    return true;
  };

  const loadExternalCatalog = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (state.agent === "codex") return;
    const agent = state.agent;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = { status: "loading", thinkingSelectionSupported: agent === "pi" };
    renderMounted(mounted);
    try {
      if (!modelControl) throw new Error("External Model control is unavailable");
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
      if (!inspection.capabilities.configuration.selectModel) {
        mounted.modelView = {
          status: "empty",
          catalog: inspection.catalog,
          thinkingSelectionSupported: false,
        };
        return;
      }
      if (inspection.catalog.models.length === 0) {
        mounted.modelView = {
          status: "empty",
          catalog: inspection.catalog,
          thinkingSelectionSupported: agent === "pi",
        };
        return;
      }
      const current = controller.get(mounted.composer);
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
        agent === "pi" && current.phase === "locked" && mounted.threadConfiguration
          ? catalogWithConfigurationState(inspection.catalog, selected, mounted.threadConfiguration)
          : inspection.catalog;
      const selectedThinkingOptionId =
        agent === "pi" && inspection.capabilities.configuration.selectThinkingOption
          ? draftThinkingOptionForModel(effectiveCatalog, selected, current.piThinkingOptionId)
          : undefined;
      if (
        current.phase === "draft" &&
        (previousModel?.id !== selected.id ||
          (agent === "pi" && current.piThinkingOptionId !== selectedThinkingOptionId))
      ) {
        if (!applyExternalConfiguration(agent, selected, selectedThinkingOptionId)) {
          throw new Error("External Model configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyAdapterAgent?.(
              agent,
              previousModel,
              agent === "pi" ? current.piThinkingOptionId : undefined,
            );
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      }
      controller.setExternalModel(mounted.composer, agent, selected);
      if (agent === "pi" && selectedThinkingOptionId) {
        controller.setPiThinkingOption(mounted.composer, selectedThinkingOptionId);
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected,
        ...(selectedThinkingOptionId ? { selectedThinkingOptionId } : {}),
        ...(mounted.threadConfiguration?.resolvedModelLabel
          ? { resolvedModelLabel: mounted.threadConfiguration.resolvedModelLabel }
          : {}),
        thinkingSelectionSupported:
          agent === "pi" && inspection.capabilities.configuration.selectThinkingOption,
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      const current = controller.get(mounted.composer);
      const selected = controller.modelForAgent(mounted.composer, agent);
      mounted.modelView = {
        status: "error",
        ...(mounted.modelView.catalog ? { catalog: mounted.modelView.catalog } : {}),
        ...(selected ? { selected } : {}),
        ...(agent === "pi" && current.piThinkingOptionId
          ? { selectedThinkingOptionId: current.piThinkingOptionId }
          : {}),
        thinkingSelectionSupported: agent === "pi",
        error: error instanceof Error ? error.message : String(error),
      };
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
    const previousThinking = agent === "pi" ? current.piThinkingOptionId : undefined;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: previousModel ?? selected,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
      thinkingSelectionSupported: agent === "pi",
    };
    renderMounted(mounted);
    try {
      let effectiveModel: HarnessModelRef;
      let effectiveThinkingOptionId: HarnessThinkingOptionId | undefined;
      let effectiveCatalog: HarnessModelCatalog;
      let resolvedModelLabel: string | undefined;
      if (current.phase === "draft") {
        effectiveModel = selected;
        effectiveThinkingOptionId =
          agent === "pi"
            ? draftThinkingOptionForModel(catalog, selected, previousThinking)
            : undefined;
        effectiveCatalog = catalog;
        if (!applyExternalConfiguration(agent, effectiveModel, effectiveThinkingOptionId)) {
          throw new Error("External Model configuration could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (previousModel && isCurrentModelRequest(mounted, generation)) {
            applyExternalConfiguration(agent, previousModel, previousThinking);
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
        effectiveThinkingOptionId = agent === "pi" ? selectableThinkingOptionId(state) : undefined;
        effectiveCatalog =
          agent === "pi" ? catalogWithConfigurationState(catalog, effectiveModel, state) : catalog;
        resolvedModelLabel = state.resolvedModelLabel;
        if (!applyExternalConfiguration(agent, effectiveModel, effectiveThinkingOptionId)) {
          throw new Error("Confirmed external Model could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrentModelRequest(mounted, generation)) return;
      controller.setExternalModel(mounted.composer, agent, effectiveModel);
      if (agent === "pi" && effectiveThinkingOptionId) {
        controller.setPiThinkingOption(mounted.composer, effectiveThinkingOptionId);
      }
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: effectiveModel,
        ...(effectiveThinkingOptionId
          ? { selectedThinkingOptionId: effectiveThinkingOptionId }
          : {}),
        ...(resolvedModelLabel ? { resolvedModelLabel } : {}),
        thinkingSelectionSupported: agent === "pi",
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      if (previousModel) applyExternalConfiguration(agent, previousModel, previousThinking);
      mounted.modelView = {
        status: "error",
        catalog,
        ...(previousModel ? { selected: previousModel } : {}),
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
        thinkingSelectionSupported: agent === "pi",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (isCurrentModelRequest(mounted, generation)) renderMounted(mounted);
    }
  };

  const selectPiThinking = async (
    mounted: MountedComposer,
    thinkingOptionId: string,
  ): Promise<void> => {
    const current = controller.get(mounted.composer);
    const catalog = mounted.modelView.catalog;
    const model = current.piModel;
    const selectedThinkingOptionId = catalog?.thinkingOptions.find(
      ({ id }) => id === thinkingOptionId,
    )?.id;
    const catalogModel = catalog?.models.find((candidate) => candidate.ref.id === model?.id);
    if (
      current.agent !== "pi" ||
      !catalog ||
      !model ||
      !selectedThinkingOptionId ||
      !catalogModel?.supportedThinkingOptionIds?.includes(selectedThinkingOptionId)
    ) {
      return;
    }
    const previousThinking = current.piThinkingOptionId;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = {
      status: "selecting",
      catalog,
      selected: model,
      ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
    };
    renderMounted(mounted);
    try {
      let effectiveThinkingOptionId = selectedThinkingOptionId;
      let effectiveCatalog = catalog;
      if (current.phase === "draft") {
        if (!(applyAdapterPiModel?.(model, selectedThinkingOptionId) ?? false)) {
          throw new Error("Pi Thinking could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          if (isCurrentModelRequest(mounted, generation)) {
            applyAdapterPiModel?.(model, previousThinking);
          }
          throw error;
        }
        if (!isCurrentModelRequest(mounted, generation)) return;
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId || !modelControl) {
          throw new Error("Pi Thread identity is unavailable for Thinking selection");
        }
        const state = await modelControl.selectThreadThinking({
          threadId,
          thinkingOptionId: selectedThinkingOptionId,
        });
        if (
          !isCurrentModelRequest(mounted, generation) ||
          controller.get(mounted.composer).agent !== "pi"
        ) {
          return;
        }
        if (state.effectiveModel && state.effectiveModel.id !== model.id) {
          throw new Error("Pi changed Model during Thinking selection");
        }
        if (!state.effectiveThinkingOptionId) {
          throw new Error("Pi did not confirm effective Thinking");
        }
        effectiveThinkingOptionId = state.effectiveThinkingOptionId;
        effectiveCatalog = catalogWithConfigurationState(catalog, model, state);
        if (!(applyAdapterPiModel?.(model, effectiveThinkingOptionId) ?? false)) {
          throw new Error("Confirmed Pi Thinking could not be applied to the Composer");
        }
        mounted.threadConfiguration = state;
      }
      if (!isCurrentModelRequest(mounted, generation)) return;
      controller.setPiThinkingOption(mounted.composer, effectiveThinkingOptionId);
      mounted.modelView = {
        status: "ready",
        catalog: effectiveCatalog,
        selected: model,
        selectedThinkingOptionId: effectiveThinkingOptionId,
      };
    } catch (error) {
      if (!isCurrentModelRequest(mounted, generation)) return;
      applyAdapterPiModel?.(model, previousThinking);
      mounted.modelView = {
        status: "error",
        catalog,
        selected: model,
        ...(previousThinking ? { selectedThinkingOptionId: previousThinking } : {}),
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
        const nextState = controller.get(mounted.composer);
        return (
          applyAdapterAgent?.(
            nextAgent,
            controller.modelForAgent(mounted.composer, nextAgent),
            nextAgent === "pi" ? nextState.piThinkingOptionId : undefined,
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
        void selectPiThinking(mounted, thinkingOptionId);
      },
    );
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
      modelView: { status: "idle" },
      ownershipStatus: threadIdFromComposerModelTarget(modelTarget) ? "loading" : "not-required",
      threadConfiguration: undefined,
    };
    mountedByComposer.set(composer, mounted);
    applyAdapterAgent?.(
      state.agent,
      controller.modelForAgent(composer, state.agent),
      state.agent === "pi" ? state.piThinkingOptionId : undefined,
    );
    renderMounted(mounted);
    if (threadIdFromComposerModelTarget(modelTarget)) {
      void loadThreadOwnership(mounted);
    } else if (state.agent !== "codex") {
      void loadExternalCatalog(mounted);
    }
  };

  const scan = (): void => {
    scanScheduled = false;
    const refreshTargets = refreshTargetsOnNextScan;
    refreshTargetsOnNextScan = false;
    if (disposed) return;
    for (const replacement of pendingReplacements.values()) {
      const sourceState = controller.get(replacement.source);
      const replacementTarget = findComposerModelTarget(replacement.target);
      if (
        shouldTransferComposerState(
          replacement.sourceModelTarget,
          replacementTarget,
          sourceState.phase,
        )
      ) {
        controller.transfer(replacement.source, replacement.target, replacementTarget);
      }
    }
    pendingReplacements.clear();
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
          source,
          sourceModelTarget: mounted.modelTarget,
          target,
        });
      }
    }
  };

  const applyComposerAgent = (composer: Element): boolean => {
    const state = controller.get(composer);
    return (
      applyAdapterAgent?.(
        state.agent,
        controller.modelForAgent(composer, state.agent),
        state.agent === "pi" ? state.piThinkingOptionId : undefined,
      ) ?? state.agent === "codex"
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
    const modelReady =
      current.agent === "codex" ||
      (mounted.modelView.status !== "selecting" &&
        mounted.modelView.catalog?.models.some(
          (model) => model.ref.id === mounted.modelView.selected?.id,
        ) === true);
    if (!modelReady) return false;
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
      return {
        composerId: selection.composerId,
        agent: selection.agent,
        phase: "locked",
        ...(model ? { model } : {}),
        ...(selection.agent === "pi" && selection.piThinkingOptionId
          ? { thinkingOptionId: selection.piThinkingOptionId }
          : {}),
      };
    },
    setAdapter(status, dispose, applyAgent, applyPiModel, nextModelControl) {
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      applyAdapterPiModel = applyPiModel ?? null;
      modelControl = nextModelControl ?? null;
      adapterStatus = status;
      sidebarAgentIcons.refresh();
      const connected = connectedComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) {
          const state = controller.get(mounted.composer);
          applyAdapterAgent?.(
            state.agent,
            controller.modelForAgent(mounted.composer, state.agent),
            state.agent === "pi" ? state.piThinkingOptionId : undefined,
          );
          if (
            threadIdFromComposerModelTarget(mounted.modelTarget) &&
            mounted.ownershipStatus !== "ready"
          ) {
            void loadThreadOwnership(mounted);
          } else if (state.agent !== "codex") {
            void loadExternalCatalog(mounted);
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
      applyAdapterPiModel = null;
      modelControl = null;
      mutationObserver.disconnect();
      sidebarAgentIcons.dispose();
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
