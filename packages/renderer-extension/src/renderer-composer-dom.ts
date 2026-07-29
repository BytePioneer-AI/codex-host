import type { ComposerAgentPhase, RendererAgent } from "./agent-selection-state.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

export interface ComposerAgentControl {
  root: HTMLElement;
  sendButton: HTMLButtonElement;
  sendDisabledBeforeSwitch: boolean | null;
  buttons: Record<RendererAgent, HTMLButtonElement>;
}

export function eventElement(target: EventTarget | null): Element | null {
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

export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(buttonText(button));
}

export function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isComposerSubmitButton(button),
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

export function isComposerSubmissionKey(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

export function composerForEditor(editor: Element): Element | null {
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

export function composerForElement(element: Element): Element | null {
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

export function mountComposerAgentControl(
  composer: Element,
  composerId: string,
  sendButton: HTMLButtonElement,
  onSelect: (agent: RendererAgent) => void,
): ComposerAgentControl {
  const root = document.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Agent");
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.gap = "2px";
  root.style.height = "28px";
  root.style.padding = "2px";
  root.style.marginInline = "4px";
  root.style.border = "1px solid rgba(127, 127, 127, 0.28)";
  root.style.borderRadius = "6px";
  root.style.background = "rgba(127, 127, 127, 0.08)";
  root.style.color = "inherit";

  const buttons = {
    codex: createAgentButton("codex", "Codex"),
    pi: createAgentButton("pi", "Pi"),
  };
  for (const agent of ["codex", "pi"] as const) {
    buttons[agent].addEventListener("click", () => onSelect(agent));
  }
  root.append(buttons.codex, buttons.pi);
  const toolbar = sendButton.parentElement;
  if (toolbar) toolbar.insertBefore(root, sendButton);
  else composer.append(root);
  return {
    root,
    sendButton,
    sendDisabledBeforeSwitch: null,
    buttons,
  };
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
): void {
  if (switching && control.sendDisabledBeforeSwitch === null) {
    control.sendDisabledBeforeSwitch = control.sendButton.disabled;
    control.sendButton.disabled = true;
  } else if (!switching && control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
    control.sendDisabledBeforeSwitch = null;
  }
  for (const candidate of ["codex", "pi"] as const) {
    const selected = candidate === state.agent;
    const button = control.buttons[candidate];
    button.setAttribute("aria-pressed", String(selected));
    button.disabled =
      switching || state.phase === "locked" || (candidate === "pi" && adapterState !== "ready");
    button.style.background = selected ? "rgba(127, 127, 127, 0.22)" : "transparent";
    button.style.boxShadow = selected ? "inset 0 0 0 1px rgba(127, 127, 127, 0.3)" : "none";
    button.style.cursor = button.disabled ? "not-allowed" : "pointer";
    button.style.opacity = button.disabled && !selected ? "0.55" : "1";
  }
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  control.root.remove();
}
