import {
  harnessIdSchema,
  type HarnessModelRef,
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
  type PiModelControlView,
} from "./renderer-composer-dom.js";
import {
  CLAUDE_CODE_TRANSPORT_MODEL_ID,
  findComposerModelTarget,
  isDraftPrewarmPolicyReady,
  isPiTransportModelId,
  threadIdFromComposerModelTarget,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";
import type { RendererModelClient } from "./renderer-model-client.js";

const piHarnessId = harnessIdSchema.parse("pi");

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
}

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: (agent: RendererAgent, model?: HarnessModelRef) => boolean,
    applyPiModel?: (model: HarnessModelRef) => boolean,
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
  piModel?: HarnessModelRef;
}

export function restoredThreadOwnership(inspection: ThreadInspection): RestoredThreadOwnership {
  if (inspection.owner === "codex") return { agent: "codex" };
  if (inspection.harnessId === "pi") {
    if (!isPiTransportModelId(inspection.transportModelId)) {
      throw new Error("Pi Thread reported an incompatible transport Model");
    }
    return {
      agent: "pi",
      ...(inspection.effectiveModel ? { piModel: inspection.effectiveModel } : {}),
    };
  }
  if (inspection.harnessId === "claude-code") {
    if (inspection.transportModelId !== CLAUDE_CODE_TRANSPORT_MODEL_ID) {
      throw new Error("Claude Code Thread reported an incompatible transport Model");
    }
    return { agent: "claude-code" };
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
  modelView: PiModelControlView;
  ownershipStatus: ComposerOwnershipStatus;
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

export function installRendererBindingProbe(
  options: RendererBindingProbeOptions = {},
): RendererBindingProbeApi {
  const existing = window.__codexhostRendererBindingProbeV1;
  if (existing) return existing;

  const enabledAgents = [...new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS)];
  const controller = new DraftAgentController<Element>({ enabledAgents });
  const mountedByComposer = new Map<Element, MountedComposer>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  let disposed = false;
  let scanScheduled = false;
  let refreshTargetsOnNextScan = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ((agent: RendererAgent, model?: HarnessModelRef) => boolean) | null = null;
  let applyAdapterPiModel: ((model: HarnessModelRef) => boolean) | null = null;
  let modelControl: RendererModelClient | null = null;
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    reason: "installing",
    decoratedRequests: 0,
    modelUpdates: 0,
    candidateCount: 0,
    candidates: [],
    hook: null,
  };

  const notifySubmission = (composer: Element, trigger: SubmissionTrigger): void => {
    const state = controller.get(composer);
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
        !controller.isCurrentOwnershipRequest(mounted.composer, generation) ||
        mountedByComposer.get(mounted.composer) !== mounted ||
        threadIdFromComposerModelTarget(mounted.modelTarget) !== threadId
      ) {
        return;
      }
      const { agent, piModel } = restoredThreadOwnership(inspection);
      const restored = controller.restore(mounted.composer, agent, piModel);
      if (!restored || !(applyAdapterAgent?.(agent, piModel) ?? agent === "codex")) {
        throw new Error("Thread owner could not be applied to the Composer");
      }
      mounted.ownershipStatus = "ready";
      if (agent === "pi") {
        mounted.modelView = { status: "loading" };
        void loadPiCatalog(mounted);
      } else {
        mounted.modelView = { status: "idle" };
      }
    } catch {
      if (!controller.isCurrentOwnershipRequest(mounted.composer, generation)) return;
      mounted.ownershipStatus = "error";
    } finally {
      if (controller.isCurrentOwnershipRequest(mounted.composer, generation)) {
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

  const loadPiCatalog = async (mounted: MountedComposer): Promise<void> => {
    const state = controller.get(mounted.composer);
    if (state.agent !== "pi") return;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = { status: "loading" };
    renderMounted(mounted);
    try {
      if (!modelControl) throw new Error("Pi Model control is unavailable");
      const inspection = await modelControl.inspectPi({ harnessId: piHarnessId });
      if (
        !controller.isCurrentModelRequest(mounted.composer, generation) ||
        controller.get(mounted.composer).agent !== "pi"
      ) {
        return;
      }
      if (inspection.status !== "ready") throw new Error(inspection.error.message);
      if (inspection.catalog.models.length === 0) {
        mounted.modelView = { status: "empty", catalog: inspection.catalog };
        return;
      }
      const current = controller.get(mounted.composer);
      const selected =
        current.piModel &&
        inspection.catalog.models.some((model) => model.ref.id === current.piModel?.id)
          ? current.piModel
          : inspection.catalog.defaultModel;
      if (!selected) throw new Error("Pi did not report its current Model");
      if (current.phase === "draft" && current.piModel?.id !== selected.id) {
        if (!(applyAdapterPiModel?.(selected) ?? false)) {
          throw new Error("Pi Model could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          applyAdapterAgent?.("pi", current.piModel);
          throw error;
        }
      }
      controller.setPiModel(mounted.composer, selected);
      mounted.modelView = {
        status: "ready",
        catalog: inspection.catalog,
        selected,
      };
    } catch (error) {
      if (!controller.isCurrentModelRequest(mounted.composer, generation)) return;
      mounted.modelView = {
        status: "error",
        ...(mounted.modelView.catalog ? { catalog: mounted.modelView.catalog } : {}),
        ...(controller.get(mounted.composer).piModel
          ? { selected: controller.get(mounted.composer).piModel }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (controller.isCurrentModelRequest(mounted.composer, generation)) renderMounted(mounted);
    }
  };

  const selectPiModel = async (mounted: MountedComposer, modelId: string): Promise<void> => {
    const current = controller.get(mounted.composer);
    const catalog = mounted.modelView.catalog;
    const selected = catalog?.models.find((model) => model.ref.id === modelId)?.ref;
    if (current.agent !== "pi" || !catalog || !selected) return;
    const previous = current.piModel;
    const generation = controller.beginModelRequest(mounted.composer);
    mounted.modelView = { status: "selecting", catalog, selected: previous ?? selected };
    renderMounted(mounted);
    try {
      let effective = selected;
      if (current.phase === "draft") {
        if (!(applyAdapterPiModel?.(selected) ?? false)) {
          throw new Error("Pi Model could not be applied to the Composer");
        }
        try {
          await clearDraftPrewarm();
        } catch (error) {
          applyAdapterAgent?.("pi", previous);
          throw error;
        }
      } else {
        const threadId = threadIdFromComposerModelTarget(mounted.modelTarget);
        if (!threadId || !modelControl) {
          throw new Error("Pi Thread identity is unavailable for Model selection");
        }
        const state = await modelControl.selectPiThreadModel({ threadId, model: selected });
        if (!state.effectiveModel) throw new Error("Pi did not confirm an effective Model");
        effective = state.effectiveModel;
        if (!catalog.models.some((model) => model.ref.id === effective.id)) {
          throw new Error("Pi activated a Model outside the current catalog");
        }
        if (!(applyAdapterPiModel?.(effective) ?? false)) {
          throw new Error("Confirmed Pi Model could not be applied to the Composer");
        }
      }
      if (!controller.isCurrentModelRequest(mounted.composer, generation)) return;
      controller.setPiModel(mounted.composer, effective);
      mounted.modelView = { status: "ready", catalog, selected: effective };
    } catch (error) {
      if (!controller.isCurrentModelRequest(mounted.composer, generation)) return;
      if (previous) applyAdapterPiModel?.(previous);
      mounted.modelView = {
        status: "error",
        catalog,
        ...(previous ? { selected: previous } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (controller.isCurrentModelRequest(mounted.composer, generation)) renderMounted(mounted);
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
          applyAdapterAgent?.(nextAgent, controller.get(mounted.composer).piModel) ??
          nextAgent === "codex"
        );
      },
      clearPrewarm: clearDraftPrewarm,
    });
    renderMounted(mounted);
    try {
      const switched = await switching;
      if (switched && controller.get(mounted.composer).agent === "pi") {
        void loadPiCatalog(mounted);
      } else if (controller.get(mounted.composer).agent !== "pi") {
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
        void selectPiModel(mounted, modelId);
      },
    );
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
      modelView: { status: "idle" },
      ownershipStatus: threadIdFromComposerModelTarget(modelTarget) ? "loading" : "not-required",
    };
    mountedByComposer.set(composer, mounted);
    applyAdapterAgent?.(state.agent, state.piModel);
    renderMounted(mounted);
    if (threadIdFromComposerModelTarget(modelTarget)) {
      void loadThreadOwnership(mounted);
    } else if (state.agent === "pi") {
      void loadPiCatalog(mounted);
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
    return applyAdapterAgent?.(state.agent, state.piModel) ?? state.agent === "codex";
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
      current.agent !== "pi" ||
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
        .map((mounted) => controller.get(mounted.composer))
        .filter((state) => state.phase === "locked");
      const selection = locked[0];
      if (locked.length !== 1 || !selection) return null;
      return {
        composerId: selection.composerId,
        agent: selection.agent,
        phase: "locked",
        ...(selection.piModel ? { model: selection.piModel } : {}),
      };
    },
    setAdapter(status, dispose, applyAgent, applyPiModel, nextModelControl) {
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      applyAdapterPiModel = applyPiModel ?? null;
      modelControl = nextModelControl ?? null;
      adapterStatus = status;
      const connected = connectedComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) {
          const state = controller.get(mounted.composer);
          applyAdapterAgent?.(state.agent, state.piModel);
          if (
            threadIdFromComposerModelTarget(mounted.modelTarget) &&
            mounted.ownershipStatus !== "ready"
          ) {
            void loadThreadOwnership(mounted);
          } else if (state.agent === "pi") {
            void loadPiCatalog(mounted);
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
