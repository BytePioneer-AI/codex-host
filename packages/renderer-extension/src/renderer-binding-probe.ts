import {
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
} from "./renderer-composer-dom.js";
import {
  findComposerModelTarget,
  isDraftPrewarmPolicyReady,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";

export interface RendererBindingProbeStatus {
  version: 2;
  mountedComposers: number;
  selections: Array<{
    composerId: string;
    agent: RendererAgent;
    phase: ComposerAgentPhase;
  }>;
  adapter: RendererAdapterStatus;
}

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  lockedSelection(): LockedComposerSelection | null;
  setAdapter(
    status: RendererAdapterStatus,
    dispose?: () => void,
    applyAgent?: (agent: RendererAgent) => boolean,
  ): void;
  dispose(): void;
}

declare global {
  interface Window {
    __codexhostRendererBindingProbeV1?: RendererBindingProbeApi;
  }
}

interface MountedComposer {
  composer: Element;
  composerId: string;
  control: ComposerAgentControl;
  modelTarget: readonly unknown[] | null;
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

export function installRendererBindingProbe(): RendererBindingProbeApi {
  const existing = window.__codexhostRendererBindingProbeV1;
  if (existing) return existing;

  const controller = new DraftAgentController<Element>();
  const mountedByComposer = new Map<Element, MountedComposer>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  let disposed = false;
  let scanScheduled = false;
  let adapterDispose: (() => void) | null = null;
  let applyAdapterAgent: ((agent: RendererAgent) => boolean) | null = null;
  let adapterStatus: RendererAdapterStatus = {
    state: "installing",
    asset: "app-initial-BbEVL4-_.js",
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
      controller.isSwitching(mounted.composer),
    );
  };

  const switchComposerAgent = async (
    mounted: MountedComposer,
    agent: RendererAgent,
  ): Promise<boolean> => {
    const composerId = controller.get(mounted.composer).composerId;
    const switching = controller.switchAgent(mounted.composer, agent, {
      applyAgent(nextAgent) {
        return applyAdapterAgent?.(nextAgent) ?? nextAgent === "codex";
      },
      async clearPrewarm() {
        const policy = window.__codexhostDraftPrewarmPolicyV1;
        if (!isDraftPrewarmPolicyReady(policy)) {
          throw new Error("Renderer draft prewarm policy is unavailable");
        }
        await policy.clear();
      },
    });
    renderMounted(mounted);
    try {
      return await switching;
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
    const control = mountComposerAgentControl(composer, state.composerId, sendButton, (agent) => {
      const mounted = mountedByComposer.get(composer);
      if (!composer.isConnected || !mounted) return;
      void switchComposerAgent(mounted, agent);
    });
    const mounted = {
      composer,
      composerId: state.composerId,
      control,
      modelTarget,
    };
    mountedByComposer.set(composer, mounted);
    applyAdapterAgent?.(state.agent);
    renderMounted(mounted);
  };

  const scan = (): void => {
    scanScheduled = false;
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
      }
    }
    for (const editor of document.querySelectorAll(EDITOR_SELECTOR)) {
      const composer = composerForEditor(editor);
      if (composer) mount(composer);
    }
  };

  const scheduleScan = (): void => {
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
    const agent = controller.get(composer).agent;
    return applyAdapterAgent?.(agent) ?? agent === "codex";
  };
  const blockEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const prepareComposer = (composer: Element): boolean | null => {
    const mounted = mountedByComposer.get(composer);
    if (!mounted) return null;
    const current = controller.get(composer);
    if (controller.isSwitching(composer)) return false;
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
    if (composer && (controller.isSwitching(composer) || !applyComposerAgent(composer))) {
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
    scheduleScan();
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
      };
    },
    setAdapter(status, dispose, applyAgent) {
      adapterDispose?.();
      adapterDispose = dispose ?? null;
      applyAdapterAgent = applyAgent ?? null;
      adapterStatus = status;
      const connected = connectedComposers();
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) applyAdapterAgent?.(controller.get(mounted.composer).agent);
      }
      for (const mounted of mountedByComposer.values()) renderMounted(mounted);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      adapterDispose?.();
      adapterDispose = null;
      applyAdapterAgent = null;
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
