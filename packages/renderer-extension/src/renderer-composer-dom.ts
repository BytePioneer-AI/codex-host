import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import {
  CONTROL_ATTRIBUTE,
  mountRendererAgentPicker,
  renderRendererAgentPicker,
  type RendererAgentPickerControl,
} from "./renderer-agent-picker.js";
import {
  mountRendererModelPicker,
  renderRendererModelPicker,
  syncRendererModelTriggerClass,
  thinkingOptionsForModel,
  type RendererModelControlView,
  type RendererModelPickerControl,
} from "./renderer-model-picker.js";
import {
  isPermissionModeControlReady,
  mountRendererPermissionModePicker,
  renderRendererPermissionModePicker,
  syncRendererPermissionModeTriggerClass,
  type RendererPermissionModeControlView,
  type RendererPermissionModePickerControl,
} from "./renderer-permission-mode-picker.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

export { CONTROL_ATTRIBUTE };
export type ExternalModelControlView = RendererModelControlView;
export type ExternalPermissionModeControlView = RendererPermissionModeControlView;
export type PiModelControlView = ExternalModelControlView;
export const CODEX_COMPOSER_SELECTOR = "[data-codex-composer-root]";
export const EDITOR_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

interface NativeControlState {
  element: HTMLElement;
  hidden: HTMLElement["hidden"];
  ariaHidden: string | null;
}

type NativeModelControlState = NativeControlState;
type NativePermissionModeControlState = NativeControlState;

export interface ComposerAgentControl {
  composer: Element;
  root: HTMLElement;
  picker: RendererAgentPickerControl;
  modelPicker: RendererModelPickerControl;
  permissionModePicker: RendererPermissionModePickerControl;
  nativeModelControl: NativeModelControlState | null;
  nativePermissionModeControl: NativePermissionModeControlState | null;
  nativePermissionModeControlVerified: boolean;
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

export function isNativePermissionModeControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-permission-mode-control") ||
    !element.matches('button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]')
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
  let ownsTrigger = false;
  let ownsComposerPermissionState = false;
  for (let depth = 0; fiber && depth < 60; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (
        props["data-composer-navigation-target"] === "permissions" &&
        props["aria-haspopup"] === "menu"
      ) {
        ownsTrigger = true;
      }
      if (
        typeof props.showPermissionsModeDropdown === "boolean" &&
        typeof props.permissionsHostId === "string" &&
        "permissionsCwdOverride" in props
      ) {
        ownsComposerPermissionState = true;
      }
    }
    const parent = fiber.return;
    fiber =
      (typeof parent === "object" || typeof parent === "function") && parent !== null
        ? (parent as typeof fiber)
        : null;
  }
  return ownsTrigger && ownsComposerPermissionState;
}

function semanticNativePermissionModeControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>(
      'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
    ),
  ].filter((element) => !element.hasAttribute("data-codexhost-permission-mode-control"));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function nativePermissionModeControlForComposer(composer: Element): HTMLElement | null {
  const candidate = semanticNativePermissionModeControlForComposer(composer);
  return candidate && isNativePermissionModeControlCandidate(candidate) ? candidate : null;
}

function nativeModelControlForComposer(composer: Element): HTMLElement | null {
  const candidates = [
    ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
  ].filter((element) => isNativeModelControlCandidate(element));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function captureNativeControl(element: HTMLElement | null): NativeControlState | null {
  return element
    ? {
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
      }
    : null;
}

function restoreNativeControl(state: NativeControlState | null): void {
  if (!state) return;
  state.element.hidden = state.hidden;
  if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
  else state.element.setAttribute("aria-hidden", state.ariaHidden);
}

function refreshNativeModelControl(control: ComposerAgentControl): void {
  const candidate = nativeModelControlForComposer(control.composer);
  if (!candidate || candidate === control.nativeModelControl?.element) return;
  restoreNativeControl(control.nativeModelControl);
  control.nativeModelControl = captureNativeControl(candidate);
  syncRendererModelTriggerClass(control.modelPicker, candidate.className);
}

function refreshNativePermissionModeControl(control: ComposerAgentControl): void {
  const semanticCandidate = semanticNativePermissionModeControlForComposer(control.composer);
  if (semanticCandidate !== control.nativePermissionModeControl?.element) {
    restoreNativeControl(control.nativePermissionModeControl);
    control.nativePermissionModeControl = captureNativeControl(semanticCandidate);
  }
  const candidate = nativePermissionModeControlForComposer(control.composer);
  control.nativePermissionModeControlVerified =
    candidate === semanticCandidate && candidate !== null;
  if (!candidate) return;
  syncRendererPermissionModeTriggerClass(control.permissionModePicker, candidate.className);
  const parent = candidate.parentElement;
  if (
    parent &&
    (control.permissionModePicker.root.parentElement !== parent ||
      control.permissionModePicker.root.nextElementSibling !== candidate)
  ) {
    parent.insertBefore(control.permissionModePicker.root, candidate);
  }
}

function setNativeControlHidden(state: NativeControlState | null, hidden: boolean): void {
  if (!state) return;
  if (!hidden) {
    restoreNativeControl(state);
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && state.element.contains(active)) active.blur();
  if (state.element.getAttribute("aria-expanded") === "true") state.element.click();
  state.element.hidden = true;
  state.element.setAttribute("aria-hidden", "true");
}

export function mountComposerAgentControl(
  composer: Element,
  composerId: string,
  sendButton: HTMLButtonElement,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onSelectModel: (modelId: string) => void,
  onSelectThinking: (thinkingOptionId: string) => void,
  onSelectPermissionMode: (permissionModeId: string) => void,
): ComposerAgentControl {
  const nativeModelControl = captureNativeControl(nativeModelControlForComposer(composer));
  const semanticNativePermissionModeControl =
    semanticNativePermissionModeControlForComposer(composer);
  const nativePermissionModeControl = captureNativeControl(semanticNativePermissionModeControl);
  const nativePermissionModeControlVerified =
    semanticNativePermissionModeControl !== null &&
    nativePermissionModeControlForComposer(composer) === semanticNativePermissionModeControl;
  const picker = mountRendererAgentPicker(composerId, enabledAgents, onSelect, onDownload);
  const modelPicker = mountRendererModelPicker(
    composerId,
    nativeModelControl?.element.className,
    onSelectModel,
    onSelectThinking,
  );
  const permissionModePicker = mountRendererPermissionModePicker(
    composerId,
    nativePermissionModeControl?.element.className,
    onSelectPermissionMode,
  );

  const permissionParent = nativePermissionModeControl?.element.parentElement;
  if (permissionParent && nativePermissionModeControl && nativePermissionModeControlVerified) {
    permissionParent.insertBefore(permissionModePicker.root, nativePermissionModeControl.element);
  } else {
    composer.append(permissionModePicker.root);
  }

  const toolbar = sendButton.parentElement;
  if (toolbar) {
    toolbar.insertBefore(modelPicker.root, sendButton);
    toolbar.insertBefore(picker.root, sendButton);
  } else {
    composer.append(modelPicker.root, picker.root);
  }
  return {
    composer,
    root: picker.root,
    picker,
    modelPicker,
    permissionModePicker,
    nativeModelControl,
    nativePermissionModeControl,
    nativePermissionModeControlVerified,
    sendButton,
    sendDisabledBeforeSwitch: null,
  };
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: Partial<Record<ExternalRendererAgent, RendererAgentAvailability>> = {},
  modelView: ExternalModelControlView = { status: "idle" },
  permissionModeView: RendererPermissionModeControlView = { status: "idle" },
): void {
  const selectedModel = modelView.selected;
  const selectedCatalogModel = modelView.catalog?.models.find(
    (model) => model.ref.id === selectedModel?.id,
  );
  const availableThinkingOptions =
    modelView.thinkingSelectionSupported === false
      ? []
      : thinkingOptionsForModel(modelView.catalog, selectedModel);
  const thinkingReady =
    availableThinkingOptions.length === 0 ||
    availableThinkingOptions.some(({ id }) => id === modelView.selectedThinkingOptionId);
  const modelReady = selectedModel !== undefined && selectedCatalogModel !== undefined;
  const modelBlocked =
    state.agent !== "codex" && (modelView.status === "selecting" || !modelReady || !thinkingReady);
  const permissionModeBlocked =
    state.agent !== "codex" &&
    (!isPermissionModeControlReady(permissionModeView) ||
      (permissionModeView.status !== "unsupported" &&
        !control.nativePermissionModeControlVerified));
  const submissionBlocked = switching || modelBlocked || permissionModeBlocked;
  if (submissionBlocked && control.sendDisabledBeforeSwitch === null) {
    control.sendDisabledBeforeSwitch = control.sendButton.disabled;
    control.sendButton.disabled = true;
  } else if (!submissionBlocked && control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
    control.sendDisabledBeforeSwitch = null;
  }
  const pickerView = renderRendererAgentPicker(
    control.picker,
    state,
    adapterState,
    switching,
    availability,
  );
  refreshNativeModelControl(control);
  refreshNativePermissionModeControl(control);
  setNativeControlHidden(control.nativeModelControl, pickerView.nativeModelHidden);
  setNativeControlHidden(control.nativePermissionModeControl, switching || state.agent !== "codex");
  renderRendererModelPicker(control.modelPicker, modelView, state.agent !== "codex");
  const permissionModeVisible =
    state.agent !== "codex" &&
    permissionModeView.status !== "idle" &&
    permissionModeView.status !== "loading" &&
    permissionModeView.status !== "unsupported" &&
    control.nativePermissionModeControlVerified;
  renderRendererPermissionModePicker(
    control.permissionModePicker,
    permissionModeView,
    permissionModeVisible,
  );
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  restoreNativeControl(control.nativeModelControl);
  restoreNativeControl(control.nativePermissionModeControl);
  control.permissionModePicker.dispose();
  control.modelPicker.dispose();
  control.picker.dispose();
}
