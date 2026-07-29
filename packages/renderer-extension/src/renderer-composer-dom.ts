import type { HarnessModelCatalog, HarnessModelRef } from "@codexhost/shared-contracts";

import type { ComposerAgentPhase, RendererAgent } from "./agent-selection-state.js";
import {
  CONTROL_ATTRIBUTE,
  mountRendererAgentPicker,
  renderRendererAgentPicker,
  type RendererAgentPickerControl,
} from "./renderer-agent-picker.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

export { CONTROL_ATTRIBUTE };
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

export interface PiModelControlView {
  status: "idle" | "loading" | "ready" | "selecting" | "empty" | "error";
  catalog?: HarnessModelCatalog;
  selected?: HarnessModelRef;
  error?: string;
}

interface NativeModelControlState {
  element: HTMLElement;
  hidden: HTMLElement["hidden"];
  ariaHidden: string | null;
}

export interface ComposerAgentControl {
  composer: Element;
  root: HTMLElement;
  picker: RendererAgentPickerControl;
  modelSelect: HTMLSelectElement;
  nativeModelControl: NativeModelControlState | null;
  sendButton: HTMLButtonElement;
  sendDisabledBeforeSwitch: boolean | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNativeModelControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-model-control") ||
    !element.matches('button[aria-haspopup="menu"]')
  ) {
    return false;
  }
  const fiberName = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  let fiber = fiberName
    ? (Object.getOwnPropertyDescriptor(element, fiberName)?.value as {
        return?: unknown;
        memoizedProps?: unknown;
      } | null)
    : null;
  for (let depth = 0; fiber && depth < 60; depth += 1) {
    const props = fiber.memoizedProps;
    if (
      isRecord(props) &&
      typeof props.onSelectModel === "function" &&
      typeof props.onSelectReasoningEffort === "function" &&
      "reasoningEffort" in props &&
      isRecord(props.fallbackPowerSelection)
    ) {
      return true;
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return false;
}

function nativeModelControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
  ].filter((element) => isNativeModelControlCandidate(element));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function captureNativeModelControl(element: HTMLElement | null): NativeModelControlState | null {
  return element
    ? {
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
      }
    : null;
}

function restoreNativeModelControl(state: NativeModelControlState | null): void {
  if (!state) return;
  state.element.hidden = state.hidden;
  if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
  else state.element.setAttribute("aria-hidden", state.ariaHidden);
}

function refreshNativeModelControl(control: ComposerAgentControl): void {
  const candidate = nativeModelControlForComposer(control.composer);
  if (!candidate || candidate === control.nativeModelControl?.element) return;
  restoreNativeModelControl(control.nativeModelControl);
  control.nativeModelControl = captureNativeModelControl(candidate);
}

function setNativeModelControlHidden(state: NativeModelControlState | null, hidden: boolean): void {
  if (!state) return;
  if (!hidden) {
    restoreNativeModelControl(state);
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && state.element.contains(active)) active.blur();
  state.element.hidden = true;
  state.element.setAttribute("aria-hidden", "true");
}

export function mountComposerAgentControl(
  composer: Element,
  composerId: string,
  sendButton: HTMLButtonElement,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onSelectModel: (modelId: string) => void,
): ComposerAgentControl {
  const nativeModelControl = captureNativeModelControl(nativeModelControlForComposer(composer));
  const picker = mountRendererAgentPicker(composerId, enabledAgents, onSelect);
  const modelSelect = document.createElement("select");
  modelSelect.setAttribute("aria-label", "Model");
  modelSelect.setAttribute("data-codexhost-model-control", composerId);
  modelSelect.style.display = "none";
  modelSelect.style.height = "28px";
  modelSelect.style.width = "clamp(132px, 18vw, 220px)";
  modelSelect.style.padding = "0 24px 0 8px";
  modelSelect.style.marginInline = "4px";
  modelSelect.style.border = "1px solid rgba(127, 127, 127, 0.28)";
  modelSelect.style.borderRadius = "6px";
  modelSelect.style.background = "rgba(127, 127, 127, 0.08)";
  modelSelect.style.color = "inherit";
  modelSelect.style.font = "500 12px/1 system-ui, sans-serif";
  modelSelect.style.letterSpacing = "0";
  modelSelect.addEventListener("change", () => onSelectModel(modelSelect.value));

  const toolbar = sendButton.parentElement;
  if (toolbar) {
    toolbar.insertBefore(modelSelect, sendButton);
    toolbar.insertBefore(picker.root, sendButton);
  } else {
    composer.append(modelSelect, picker.root);
  }
  return {
    composer,
    root: picker.root,
    picker,
    modelSelect,
    nativeModelControl,
    sendButton,
    sendDisabledBeforeSwitch: null,
  };
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  modelView: PiModelControlView = { status: "idle" },
): void {
  const selectedModel = modelView.selected;
  const modelReady =
    modelView.catalog !== undefined &&
    selectedModel !== undefined &&
    modelView.catalog.models.some((model) => model.ref.id === selectedModel.id);
  const modelBlocked = state.agent === "pi" && (modelView.status === "selecting" || !modelReady);
  const submissionBlocked = switching || modelBlocked;
  if (submissionBlocked && control.sendDisabledBeforeSwitch === null) {
    control.sendDisabledBeforeSwitch = control.sendButton.disabled;
    control.sendButton.disabled = true;
  } else if (!submissionBlocked && control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
    control.sendDisabledBeforeSwitch = null;
  }
  const pickerView = renderRendererAgentPicker(control.picker, state, adapterState, switching);
  refreshNativeModelControl(control);
  setNativeModelControlHidden(control.nativeModelControl, pickerView.nativeModelHidden);
  control.modelSelect.style.display = state.agent === "pi" ? "inline-block" : "none";
  if (state.agent === "pi") {
    const catalogSignature =
      modelView.catalog?.models
        .map((model) => `${model.ref.id}\u0000${model.label}`)
        .join("\u0001") ?? `:${modelView.status}`;
    if (control.modelSelect.dataset.catalogSignature !== catalogSignature) {
      control.modelSelect.replaceChildren();
      if (modelView.catalog && modelView.catalog.models.length > 0) {
        for (const model of modelView.catalog.models) {
          const option = document.createElement("option");
          option.value = model.ref.id;
          option.textContent = model.label;
          control.modelSelect.append(option);
        }
      } else {
        const option = document.createElement("option");
        option.value = "";
        option.textContent =
          modelView.status === "loading"
            ? "Loading models..."
            : modelView.status === "empty"
              ? "No Pi models"
              : "Models unavailable";
        control.modelSelect.append(option);
      }
      control.modelSelect.dataset.catalogSignature = catalogSignature;
    }
    if (selectedModel) control.modelSelect.value = selectedModel.id;
    control.modelSelect.disabled =
      modelView.status === "loading" ||
      modelView.status === "selecting" ||
      modelView.status === "empty" ||
      modelView.catalog === undefined;
    control.modelSelect.title = modelView.error ?? "Pi Model";
    control.modelSelect.style.cursor = control.modelSelect.disabled ? "not-allowed" : "pointer";
    control.modelSelect.style.opacity = control.modelSelect.disabled ? "0.65" : "1";
  }
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  restoreNativeModelControl(control.nativeModelControl);
  control.picker.dispose();
  control.modelSelect.remove();
}
