import {
  AgentSelectionRegistry,
  type ComposerAgentPhase,
  type RendererAgent,
  type RendererSubmissionObservation,
  type SubmissionTrigger,
} from "./agent-selection-state.js";
import {
  findComposerModelTarget,
  type LockedComposerSelection,
  type RendererAdapterStatus,
} from "./versioned-renderer-adapter.js";

export interface RendererBindingProbeStatus {
  version: 1;
  mountedComposers: number;
  selections: Array<{
    composerId: string;
    agent: RendererAgent;
    phase: "draft" | "locked";
  }>;
  observations: RendererSubmissionObservation[];
  adapter: RendererAdapterStatus;
  diagnostics: {
    editorCandidates: number;
    replacementTransfers: number;
    shapes: Array<{
      tagName: string;
      role: string | null;
      contentEditable: string | null;
      hasPlaceholder: boolean;
      hasDataPlaceholder: boolean;
      ancestorTags: string[];
      ancestorButtonCounts: number[];
    }>;
    bottomCenterStack: Array<{
      tagName: string;
      attributeNames: string[];
      tabIndex: number;
      contentEditable: string;
    }>;
    bottomFocusable: Array<{
      tagName: string;
      attributeNames: string[];
      tabIndex: number;
    }>;
  };
}

export interface RendererBindingProbeApi {
  status(): RendererBindingProbeStatus;
  setAgent(composerId: string, agent: RendererAgent): boolean;
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
  control: HTMLElement;
  sendButton: HTMLButtonElement;
  buttons: Record<RendererAgent, HTMLButtonElement>;
  modelTarget: readonly unknown[] | null;
}

interface PendingComposerReplacement {
  source: Element;
  sourceModelTarget: readonly unknown[] | null;
  target: Element;
}

const CONTROL_ATTRIBUTE = "data-codexhost-agent-probe";
const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
const DIAGNOSTIC_SELECTOR =
  "[placeholder], [data-placeholder], [contenteditable], [role='textbox']";

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function buttonText(button: HTMLButtonElement): string {
  return [
    button.type,
    button.getAttribute("aria-label"),
    button.getAttribute("title"),
    button.getAttribute("data-testid"),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isSendButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(buttonText(button));
}

function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isSendButton(button),
    ) ?? null
  );
}

export function editorForElement(element: Element): Element | null {
  return element.matches(EDITOR_SELECTOR) ? element : element.closest(EDITOR_SELECTOR);
}

export function isComposerInputIntent(event: KeyboardEvent): boolean {
  if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") return true;
  if (event.key === "Process") return true;
  if ((event.ctrlKey || event.metaKey) && ["v", "x"].includes(event.key.toLowerCase())) return true;
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

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

function composerForEditor(editor: Element): Element | null {
  const codexComposer = editor.closest(CODEX_COMPOSER_SELECTOR);
  if (codexComposer) return codexComposer;
  const form = editor.closest("form");
  if (form && sendButtonWithin(form)) return form;
  let candidate = editor.parentElement;
  for (let depth = 0; candidate && candidate !== document.body && depth < 8; depth += 1) {
    if (sendButtonWithin(candidate)) return candidate;
    candidate = candidate.parentElement;
  }
  return null;
}

function composerForElement(element: Element): Element | null {
  const codexComposer = element.closest(CODEX_COMPOSER_SELECTOR);
  if (codexComposer) return codexComposer;
  const mounted = element.closest(`[${CONTROL_ATTRIBUTE}]`);
  if (mounted) return mounted.parentElement;
  const editor = editorForElement(element);
  if (editor) return composerForEditor(editor);
  let candidate: Element | null = element;
  for (let depth = 0; candidate && candidate !== document.body && depth < 8; depth += 1) {
    if (candidate.querySelector(`[${CONTROL_ATTRIBUTE}]`)) return candidate;
    candidate = candidate.parentElement;
  }
  return null;
}

function structuralDiagnostics(
  replacementTransfers: number,
): RendererBindingProbeStatus["diagnostics"] {
  const candidates = [...document.querySelectorAll(DIAGNOSTIC_SELECTOR)].slice(0, 12);
  const elementShape = (element: Element) => ({
    tagName: element.tagName.toLowerCase(),
    attributeNames: element.getAttributeNames().sort(),
    tabIndex: element instanceof HTMLElement ? element.tabIndex : -1,
  });
  const bottomCenterStack = document
    .elementsFromPoint(window.innerWidth / 2, Math.max(0, window.innerHeight - 90))
    .slice(0, 12)
    .map((element) => ({
      ...elementShape(element),
      contentEditable: element instanceof HTMLElement ? element.contentEditable : "inherit",
    }));
  const bottomFocusable = [...document.querySelectorAll<HTMLElement>("*")]
    .filter((element) => {
      const bounds = element.getBoundingClientRect();
      return element.tabIndex >= 0 && bounds.top >= window.innerHeight * 0.65 && bounds.height > 0;
    })
    .slice(0, 20)
    .map(elementShape);
  return {
    editorCandidates: document.querySelectorAll(EDITOR_SELECTOR).length,
    replacementTransfers,
    shapes: candidates.map((candidate) => {
      const ancestorTags: string[] = [];
      const ancestorButtonCounts: number[] = [];
      let ancestor: Element | null = candidate;
      for (let depth = 0; ancestor && ancestor !== document.body && depth < 6; depth += 1) {
        ancestorTags.push(ancestor.tagName.toLowerCase());
        ancestorButtonCounts.push(ancestor.querySelectorAll("button").length);
        ancestor = ancestor.parentElement;
      }
      return {
        tagName: candidate.tagName.toLowerCase(),
        role: candidate.getAttribute("role"),
        contentEditable: candidate.getAttribute("contenteditable"),
        hasPlaceholder: candidate.hasAttribute("placeholder"),
        hasDataPlaceholder: candidate.hasAttribute("data-placeholder"),
        ancestorTags,
        ancestorButtonCounts,
      };
    }),
    bottomCenterStack,
    bottomFocusable,
  };
}

function createAgentButton(agent: RendererAgent, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.agent = agent;
  button.textContent = label;
  button.style.height = "24px";
  button.style.minWidth = "44px";
  button.style.padding = "0 8px";
  button.style.border = "0";
  button.style.borderRadius = "4px";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "500 12px/1 system-ui, sans-serif";
  button.style.letterSpacing = "0";
  button.style.cursor = "pointer";
  return button;
}

function updateButtons(
  mounted: MountedComposer,
  state: { agent: RendererAgent; phase: "draft" | "locked" },
  adapterState: RendererAdapterStatus["state"],
): void {
  for (const candidate of ["codex", "pi"] as const) {
    const selected = candidate === state.agent;
    const button = mounted.buttons[candidate];
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = state.phase === "locked" || (candidate === "pi" && adapterState !== "ready");
    button.style.background = selected ? "rgba(127, 127, 127, 0.22)" : "transparent";
    button.style.boxShadow = selected ? "inset 0 0 0 1px rgba(127, 127, 127, 0.3)" : "none";
    button.style.cursor = button.disabled ? "not-allowed" : "pointer";
    button.style.opacity = button.disabled && !selected ? "0.55" : "1";
  }
}

export function installRendererBindingProbe(): RendererBindingProbeApi {
  const existing = window.__codexhostRendererBindingProbeV1;
  if (existing) return existing;

  const registry = new AgentSelectionRegistry<Element>();
  const mountedByComposer = new Map<Element, MountedComposer>();
  const pendingReplacements = new Map<Element, PendingComposerReplacement>();
  const observations: RendererSubmissionObservation[] = [];
  let disposed = false;
  let scanScheduled = false;
  let replacementTransfers = 0;
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

  const record = (composer: Element, trigger: SubmissionTrigger): void => {
    const observation = registry.capture(composer, trigger);
    if (!observation) return;
    observations.push(observation);
    if (observations.length > 50) observations.shift();
    window.dispatchEvent(
      new CustomEvent("codexhost:renderer-submission", {
        detail: observation,
      }),
    );
  };

  const mount = (composer: Element): void => {
    if (mountedByComposer.has(composer) || !composer.isConnected) return;
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (!sendButton) return;
    const state = registry.get(composer);
    const control = document.createElement("div");
    control.setAttribute(CONTROL_ATTRIBUTE, state.composerId);
    control.setAttribute("role", "group");
    control.setAttribute("aria-label", "Agent");
    control.style.display = "inline-flex";
    control.style.alignItems = "center";
    control.style.gap = "2px";
    control.style.height = "28px";
    control.style.padding = "2px";
    control.style.marginInline = "4px";
    control.style.border = "1px solid rgba(127, 127, 127, 0.28)";
    control.style.borderRadius = "6px";
    control.style.background = "rgba(127, 127, 127, 0.08)";
    control.style.color = "inherit";

    const buttons = {
      codex: createAgentButton("codex", "Codex"),
      pi: createAgentButton("pi", "Pi"),
    };
    control.append(buttons.codex, buttons.pi);
    const mounted: MountedComposer = {
      composer,
      composerId: state.composerId,
      control,
      sendButton,
      buttons,
      modelTarget: findComposerModelTarget(composer),
    };
    for (const agent of ["codex", "pi"] as const) {
      buttons[agent].addEventListener("click", () => {
        if (!applyAdapterAgent?.(agent) || !composer.isConnected) return;
        updateButtons(mounted, registry.setAgent(composer, agent), adapterStatus.state);
      });
    }
    const toolbar = sendButton.parentElement;
    if (toolbar) toolbar.insertBefore(control, sendButton);
    else composer.append(control);
    mountedByComposer.set(composer, mounted);
    applyAdapterAgent?.(state.agent);
    updateButtons(mounted, state, adapterStatus.state);
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    for (const replacement of pendingReplacements.values()) {
      const sourceState = registry.get(replacement.source);
      if (
        shouldTransferComposerState(
          replacement.sourceModelTarget,
          findComposerModelTarget(replacement.target),
          sourceState.phase,
        ) &&
        registry.transfer(replacement.source, replacement.target)
      ) {
        replacementTransfers += 1;
      }
    }
    pendingReplacements.clear();
    for (const [composer, mounted] of mountedByComposer) {
      if (!composer.isConnected || !mounted.control.isConnected) {
        mounted.control.remove();
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
        for (const composer of composerRootsWithin(addedNode)) {
          replacement.added.add(composer);
        }
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
    const agent = registry.get(composer).agent;
    return applyAdapterAgent?.(agent) ?? agent === "codex";
  };
  const blockEvent = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const lockForTarget = (
    target: EventTarget | null,
  ): { composer: Element; applied: boolean } | null => {
    const element = eventElement(target);
    const editor = element ? editorForElement(element) : null;
    if (!editor) return null;
    const composer = composerForEditor(editor);
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (!composer || !mounted) return null;
    const current = registry.get(composer);
    if (current.phase === "locked") return { composer, applied: true };
    if (!applyComposerAgent(composer)) return { composer, applied: false };
    const locked = registry.lock(composer);
    updateButtons(mounted, locked, adapterStatus.state);
    return { composer, applied: true };
  };
  const onBeforeInput = (event: InputEvent): void => {
    const prepared = lockForTarget(event.target);
    if (prepared && !prepared.applied) blockEvent(event);
  };
  const onSubmit = (event: Event): void => {
    const element = eventElement(event.target);
    const composer = element ? composerForElement(element) : null;
    if (!composer || !mountedByComposer.has(composer)) return;
    if (!applyComposerAgent(composer)) {
      blockEvent(event);
      return;
    }
    record(composer, "submit");
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const prepared = isComposerInputIntent(event) ? lockForTarget(event.target) : null;
    if (prepared && !prepared.applied) {
      blockEvent(event);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || !prepared) return;
    if (!applyComposerAgent(prepared.composer)) {
      blockEvent(event);
      return;
    }
    record(prepared.composer, "enter");
  };
  const onClick = (event: MouseEvent): void => {
    const element = eventElement(event.target);
    const button = element?.closest<HTMLButtonElement>("button");
    if (!button) return;
    const composer = composerForElement(button);
    const mounted = composer ? mountedByComposer.get(composer) : undefined;
    if (!composer || mounted?.sendButton !== button) return;
    if (!applyComposerAgent(composer)) {
      blockEvent(event);
      return;
    }
    record(composer, "click");
  };

  const mutationObserver = new MutationObserver((mutations) => {
    transferReplacedComposers(mutations);
    scheduleScan();
  });
  const onAdapterStatus = () => {
    for (const mounted of mountedByComposer.values()) {
      updateButtons(mounted, registry.get(mounted.composer), adapterStatus.state);
    }
  };
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("beforeinput", onBeforeInput, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  window.addEventListener("codexhost:renderer-adapter-status", onAdapterStatus);

  const api: RendererBindingProbeApi = {
    status() {
      const selections = [...mountedByComposer.values()]
        .filter((mounted) => mounted.composer.isConnected && mounted.control.isConnected)
        .map((mounted) => ({
          composerId: mounted.composerId,
          agent: registry.get(mounted.composer).agent,
          phase: registry.get(mounted.composer).phase,
        }));
      return {
        version: 1,
        mountedComposers: selections.length,
        selections,
        observations: observations.map((observation) => ({ ...observation })),
        adapter: { ...adapterStatus },
        diagnostics: structuralDiagnostics(replacementTransfers),
      };
    },
    setAgent(composerId, agent) {
      const mounted = [...mountedByComposer.values()].find(
        (candidate) => candidate.composerId === composerId,
      );
      if (!mounted) return false;
      const applied = applyAdapterAgent?.(agent);
      if (applied !== true) return false;
      const state = registry.setAgent(mounted.composer, agent);
      updateButtons(mounted, state, adapterStatus.state);
      return state.agent === agent;
    },
    lockedSelection() {
      const locked = [...mountedByComposer.values()]
        .filter((mounted) => mounted.composer.isConnected && mounted.control.isConnected)
        .map((mounted) => registry.get(mounted.composer))
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
      const connected = [...mountedByComposer.values()].filter(
        (mounted) => mounted.composer.isConnected && mounted.control.isConnected,
      );
      if (connected.length === 1) {
        const mounted = connected[0];
        if (mounted) applyAdapterAgent?.(registry.get(mounted.composer).agent);
      }
      for (const mounted of mountedByComposer.values()) {
        updateButtons(mounted, registry.get(mounted.composer), adapterStatus.state);
      }
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
      for (const mounted of mountedByComposer.values()) mounted.control.remove();
      mountedByComposer.clear();
      pendingReplacements.clear();
      delete window.__codexhostRendererBindingProbeV1;
    },
  };
  window.__codexhostRendererBindingProbeV1 = api;
  scan();
  return api;
}
