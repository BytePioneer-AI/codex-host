import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import type {
  AccountCreditsSnapshot,
  HarnessCommandDescriptor,
  ThreadUsageSnapshot,
} from "@codexhost/shared-contracts";
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
import {
  mountRendererCreditsControl,
  renderRendererCreditsControl,
  type RendererCreditsControl,
} from "./renderer-credits-control.js";
import {
  clearRendererNativeContextUsage,
  syncRendererNativeContextUsage,
} from "./renderer-usage-control.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";
import {
  mountRendererHarnessCommandControl,
  type RendererHarnessCommandControl,
} from "./renderer-harness-command-control.js";

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

export interface RendererComposerContractInspection {
  composerCount: number;
  visibleComposerCount: number;
  activeComposerCount: number;
  modelCandidateCount: number;
  verifiedModelCandidateCount: number;
  permissionCandidateCount: number;
  verifiedPermissionCandidateCount: number;
  contextUsageCandidateCount: number;
  verifiedContextUsageCandidateCount: number;
  sendButtonCount: number;
  trailingActionOwnerCount: number;
}

export interface ComposerAgentControl {
  composer: Element;
  root: HTMLElement;
  picker: RendererAgentPickerControl;
  modelPicker: RendererModelPickerControl;
  permissionModePicker: RendererPermissionModePickerControl;
  nativeModelControl: NativeModelControlState | null;
  nativePermissionModeControl: NativePermissionModeControlState | null;
  nativeContextUsageControl?: NativeControlState | null;
  nativePermissionModeControlVerified: boolean;
  credits: RendererCreditsControl;
  composerId: string;
  harnessCommands: RendererHarnessCommandControl;
  sendButton: HTMLButtonElement;
  sendDisabledBeforeSwitch: boolean | null;
}

export function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

function controlDescription(element: Element): string {
  const typed = element as HTMLButtonElement;
  const read = (name: string): string | null =>
    typeof element.getAttribute === "function" ? element.getAttribute(name) : null;
  return [typed.type, read("aria-label"), read("title"), read("data-testid")]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function buttonText(button: HTMLButtonElement): string {
  return controlDescription(button);
}

function isOwnedRendererControl(element: Element): boolean {
  return (
    element.hasAttribute(CONTROL_ATTRIBUTE) ||
    element.hasAttribute("data-codexhost-model-control") ||
    element.hasAttribute("data-codexhost-permission-mode-control") ||
    element.hasAttribute("data-codexhost-usage-control") ||
    element.hasAttribute("data-codexhost-credits-control") ||
    element.hasAttribute("data-codexhost-harness-command-control")
  );
}

export function isComposerSubmitButton(button: HTMLButtonElement): boolean {
  if (button.type === "submit") return true;
  return /(^|\s)(send|submit|发送|提交)(\s|$)/u.test(buttonText(button));
}

const VOICE_CONTROL_PATTERN =
  /(dictat|microphone|speech(?:[-_\s]?to[-_\s]?text)?|voice[-_\s]?input|(^|\s)voice(\s|$)|composer[-_](?:speech|dictat|mic)|语音|听写|麦克风|pause|暂停|stop recording|stop dictation|停止录音|停止听写|(^|\s)stop(\s|$))/iu;
const CANCEL_CONTROL_PATTERN = /(cancel|discard|close|dismiss|取消|关闭|丢弃)/iu;
const TRAILING_ACTION_WALK_DEPTH = 3;

function isComposerCancelButton(element: Element): boolean {
  if (isOwnedRendererControl(element)) return false;
  return CANCEL_CONTROL_PATTERN.test(controlDescription(element));
}

export function isComposerVoiceButton(element: Element): boolean {
  if (isOwnedRendererControl(element) || isComposerCancelButton(element)) return false;
  const description = controlDescription(element);
  if (/(^|\s)(send|submit|发送|提交)(\s|$)/u.test(description)) return false;
  return VOICE_CONTROL_PATTERN.test(description);
}

function isComposerTrailingActionButton(element: Element): boolean {
  return isComposerVoiceButton(element) || isComposerSubmitButton(element as HTMLButtonElement);
}

function isTrailingActionNode(element: Element): boolean {
  if (isComposerCancelButton(element)) return false;
  if (isComposerTrailingActionButton(element)) return true;
  if (typeof element.querySelectorAll !== "function") return false;
  const buttons = [...element.querySelectorAll("button")];
  return buttons.length > 0 && buttons.every((button) => isComposerTrailingActionButton(button));
}

export function sendButtonWithin(root: Element): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      isComposerSubmitButton(button),
    ) ?? null
  );
}

function leftmostTrailingSibling(container: Element, before: Element): HTMLElement | null {
  for (const child of container.children) {
    if (child === before) break;
    if (typeof (child as HTMLElement).hasAttribute !== "function") continue;
    const element = child as HTMLElement;
    if (isOwnedRendererControl(element) || isComposerCancelButton(element)) continue;
    if (isTrailingActionNode(element)) return element;
  }
  return null;
}

export function trailingActionAnchor(sendButton: HTMLButtonElement): HTMLElement {
  let container: HTMLElement | null = sendButton.parentElement;
  let before: HTMLElement = sendButton;
  for (let depth = 0; container && depth < TRAILING_ACTION_WALK_DEPTH; depth += 1) {
    if (typeof container.matches === "function" && container.matches(CODEX_COMPOSER_SELECTOR)) {
      break;
    }
    const candidate = leftmostTrailingSibling(container, before);
    if (candidate) return candidate;
    before = container;
    container = container.parentElement;
  }
  return sendButton;
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
  return editor.closest(CODEX_COMPOSER_SELECTOR);
}

export function composerForElement(element: Element): Element | null {
  return element.closest(CODEX_COMPOSER_SELECTOR);
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
  if (
    element.getAttribute("data-codex-intelligence-trigger") === "true" &&
    element.getAttribute("data-composer-navigation-target") === "reasoning"
  ) {
    return true;
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

export function isNativeContextUsageControlCandidate(element: Element): boolean {
  if (
    element.hasAttribute("data-codexhost-usage-control") ||
    element.hasAttribute("data-codexhost-credits-control")
  ) {
    return false;
  }
  // Codex's current Composer footer renders Context Usage as this exact
  // accessible radial indicator. The DOM shape is more stable than its
  // localized aria-label or generated CSS module class names.
  return (
    nativeContextUsageElementVisible(element) &&
    element.matches('span[role="img"][aria-label]') &&
    element.querySelectorAll("svg > circle").length === 2
  );
}

function nativeContextUsageElementVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const typed = current as HTMLElement;
    if (
      typed.hidden ||
      (typeof current.getAttribute === "function" && current.getAttribute("aria-hidden") === "true")
    ) {
      return false;
    }
    const inlineStyle = typed.style;
    if (
      inlineStyle &&
      (inlineStyle.display === "none" ||
        inlineStyle.visibility === "hidden" ||
        inlineStyle.opacity === "0")
    ) {
      return false;
    }
    const view = current.ownerDocument?.defaultView;
    if (!view?.getComputedStyle) continue;
    try {
      const style = view.getComputedStyle(typed);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
    } catch {
      // A detached or test-only element may not be accepted by getComputedStyle.
    }
  }
  return true;
}

const contextUsageLabelPattern = /(context|usage|token|上下文|用量|令牌|背景信息窗口)/iu;

export function nativeContextUsageControlForComposer(composer: Element): HTMLElement | null {
  const candidates = nativeContextUsageCandidatesForComposer(composer);
  const verified = candidates.filter(isNativeContextUsageControlCandidate);
  if (verified.length === 0) return null;
  const described = verified.filter((element) =>
    contextUsageLabelPattern.test(element.getAttribute("aria-label") ?? ""),
  );
  if (described.length === 1) return described[0] ?? null;
  return verified.length === 1 ? (verified[0] ?? null) : null;
}

function nativeContextUsageCandidatesForComposer(composer: Element): HTMLElement[] {
  return [...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]')];
}

function contractElementVisible(element: Element): boolean {
  const typed = element as HTMLElement;
  const bounds = typed.getBoundingClientRect?.();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return false;
  if (typed.hidden || typed.getAttribute?.("aria-hidden") === "true") return false;
  const view = element.ownerDocument?.defaultView;
  const style = view?.getComputedStyle?.(typed);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

export function inspectRendererComposerContract(
  root: ParentNode = document,
): RendererComposerContractInspection {
  const composers = [...root.querySelectorAll<Element>(CODEX_COMPOSER_SELECTOR)];
  const result: RendererComposerContractInspection = {
    composerCount: composers.length,
    visibleComposerCount: 0,
    activeComposerCount: 0,
    modelCandidateCount: 0,
    verifiedModelCandidateCount: 0,
    permissionCandidateCount: 0,
    verifiedPermissionCandidateCount: 0,
    contextUsageCandidateCount: 0,
    verifiedContextUsageCandidateCount: 0,
    sendButtonCount: 0,
    trailingActionOwnerCount: 0,
  };
  for (const composer of composers) {
    if (contractElementVisible(composer)) result.visibleComposerCount += 1;
    const editors = [...composer.querySelectorAll<HTMLElement>(EDITOR_SELECTOR)].filter(
      contractElementVisible,
    );
    const allButtons = [...composer.querySelectorAll<HTMLButtonElement>("button")];
    const sendButton = sendButtonWithin(composer) ?? allButtons.at(-1) ?? null;
    if (editors.length === 1 && sendButton !== null) result.activeComposerCount += 1;
    if (sendButton) {
      result.sendButtonCount += 1;
      if (trailingActionAnchor(sendButton).parentElement !== null) {
        result.trailingActionOwnerCount += 1;
      }
    }
    const modelCandidates = [
      ...composer.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]'),
    ].filter((element) => !isOwnedRendererControl(element));
    result.modelCandidateCount += modelCandidates.length;
    result.verifiedModelCandidateCount += modelCandidates.filter(
      isNativeModelControlCandidate,
    ).length;
    const permissionCandidates = [
      ...composer.querySelectorAll<HTMLElement>(
        'button[aria-haspopup="menu"][data-composer-navigation-target="permissions"]',
      ),
    ].filter((element) => !element.hasAttribute("data-codexhost-permission-mode-control"));
    result.permissionCandidateCount += permissionCandidates.length;
    result.verifiedPermissionCandidateCount += permissionCandidates.filter(
      isNativePermissionModeControlCandidate,
    ).length;
    const contextCandidates = [
      ...composer.querySelectorAll<HTMLElement>('span[role="img"][aria-label]'),
    ].filter((element) => !isOwnedRendererControl(element));
    result.contextUsageCandidateCount += contextCandidates.length;
    result.verifiedContextUsageCandidateCount += contextCandidates.filter(
      isNativeContextUsageControlCandidate,
    ).length;
  }
  return result;
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

function restoreNativeControl(state: NativeControlState | null | undefined): void {
  if (!state) return;
  state.element.hidden = state.hidden;
  if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
  else state.element.setAttribute("aria-hidden", state.ariaHidden);
}

function removeLegacyUsageControl(composer: Element, composerId: string): void {
  for (const element of composer.querySelectorAll<HTMLElement>("[data-codexhost-usage-control]")) {
    element.remove();
  }
  composer.ownerDocument?.getElementById(`${composerId}-usage-popover`)?.remove();
}

function refreshNativeContextUsageControl(control: ComposerAgentControl): void {
  const candidate = nativeContextUsageControlForComposer(control.composer);
  if (candidate === control.nativeContextUsageControl?.element) return;
  clearRendererNativeContextUsage(control.nativeContextUsageControl?.element ?? null);
  restoreNativeControl(control.nativeContextUsageControl);
  control.nativeContextUsageControl = captureNativeControl(candidate);
}

function refreshNativeModelControl(control: ComposerAgentControl): void {
  const candidate = nativeModelControlForComposer(control.composer);
  if (!candidate) return;
  if (candidate !== control.nativeModelControl?.element) {
    restoreNativeControl(control.nativeModelControl);
    control.nativeModelControl = captureNativeControl(candidate);
    syncRendererModelTriggerClass(control.modelPicker);
  }
}

/**
 * Credits stays attached to the renderer-owned permission-mode slot. It is
 * independent from the native context indicator because Credits describes
 * account limits, not the current thread's context window.
 */
export function creditsPlacementAnchor(control: ComposerAgentControl): HTMLElement | null {
  const root = control.permissionModePicker?.root;
  return root?.parentElement ? root : null;
}

function refreshTrailingClusterPlacement(control: ComposerAgentControl): void {
  const sendButton = control.sendButton;
  const modelRoot = control.modelPicker?.root;
  const agentRoot = control.root ?? control.picker?.root;
  if (!sendButton || !modelRoot || !agentRoot) return;
  const anchor = trailingActionAnchor(sendButton);
  const parent = anchor.parentElement;
  if (!parent || typeof parent.insertBefore !== "function") return;
  if (
    modelRoot.parentElement === parent &&
    agentRoot.parentElement === parent &&
    modelRoot.nextElementSibling === agentRoot &&
    agentRoot.nextElementSibling === anchor
  ) {
    return;
  }
  parent.insertBefore(modelRoot, anchor);
  parent.insertBefore(agentRoot, anchor);
}

// Credits is independent of any Usage surface, so it stays put even when the
// native Context control is still resolving (or has no reliable candidate).
function refreshCreditsPlacement(control: ComposerAgentControl): void {
  const anchor = creditsPlacementAnchor(control);
  if (!anchor) {
    if (control.credits.anchor) control.credits.root.remove();
    control.credits.anchor = null;
    return;
  }
  control.credits.place(anchor);
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
  syncRendererPermissionModeTriggerClass(control.permissionModePicker);
  const parent = candidate.parentElement;
  if (
    parent &&
    (control.permissionModePicker.root.parentElement !== parent ||
      control.permissionModePicker.root.nextElementSibling !== candidate)
  ) {
    parent.insertBefore(control.permissionModePicker.root, candidate);
  }
}

function setNativeControlHidden(
  state: NativeControlState | null | undefined,
  hidden: boolean,
): void {
  if (!state) return;
  if (!hidden) {
    restoreNativeControl(state);
    return;
  }
  if (state.element.hidden && state.element.getAttribute("aria-hidden") === "true") return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (
    active &&
    typeof (active as HTMLElement).blur === "function" &&
    state.element.contains(active)
  ) {
    (active as HTMLElement).blur();
  }
  if (state.element.getAttribute("aria-expanded") === "true") state.element.click();
  state.element.hidden = true;
  state.element.setAttribute("aria-hidden", "true");
}

export function reconcileComposerNativeControls(
  control: ComposerAgentControl,
  hideModel: boolean,
  hidePermissionMode: boolean,
): void {
  refreshNativeContextUsageControl(control);
  refreshNativeModelControl(control);
  // Resolve the permission-mode picker's position before Credits anchors to
  // it below, so Credits never reads a stale (e.g. mount-time fallback)
  // location for it within this same pass.
  refreshNativePermissionModeControl(control);
  refreshTrailingClusterPlacement(control);
  refreshCreditsPlacement(control);
  setNativeControlHidden(control.nativeModelControl, hideModel);
  // Context usage is shared by Codex and external Harnesses. External Usage
  // data is projected into the same native Codex indicator, so it must remain
  // visible when the external Model control is substituted.
  setNativeControlHidden(control.nativeContextUsageControl, false);
  setNativeControlHidden(control.nativePermissionModeControl, hidePermissionMode);
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
  onSelectCommand: (command: HarnessCommandDescriptor) => void,
): ComposerAgentControl {
  removeLegacyUsageControl(composer, composerId);
  const nativeModelControl = captureNativeControl(nativeModelControlForComposer(composer));
  const nativeContextUsageControl = captureNativeControl(
    nativeContextUsageControlForComposer(composer),
  );
  const semanticNativePermissionModeControl =
    semanticNativePermissionModeControlForComposer(composer);
  const nativePermissionModeControl = captureNativeControl(semanticNativePermissionModeControl);
  const nativePermissionModeControlVerified =
    semanticNativePermissionModeControl !== null &&
    nativePermissionModeControlForComposer(composer) === semanticNativePermissionModeControl;
  const picker = mountRendererAgentPicker(composerId, enabledAgents, onSelect, onDownload);
  const modelPicker = mountRendererModelPicker(composerId, onSelectModel, onSelectThinking);
  const permissionModePicker = mountRendererPermissionModePicker(
    composerId,
    onSelectPermissionMode,
  );
  const credits = mountRendererCreditsControl(composerId);

  const toolbar = sendButton.parentElement;
  const harnessCommands = mountRendererHarnessCommandControl(
    toolbar ?? composer,
    trailingActionAnchor(sendButton),
    onSelectCommand,
  );

  const permissionParent = nativePermissionModeControl?.element.parentElement;
  if (permissionParent && nativePermissionModeControl && nativePermissionModeControlVerified) {
    permissionParent.insertBefore(permissionModePicker.root, nativePermissionModeControl.element);
  } else {
    composer.append(permissionModePicker.root);
  }

  if (!toolbar) composer.append(modelPicker.root, picker.root);
  const control = {
    composer,
    composerId,
    root: picker.root,
    picker,
    modelPicker,
    permissionModePicker,
    nativeModelControl,
    nativePermissionModeControl,
    nativeContextUsageControl,
    nativePermissionModeControlVerified,
    credits,
    harnessCommands,
    sendButton,
    sendDisabledBeforeSwitch: null,
  } satisfies ComposerAgentControl;
  refreshTrailingClusterPlacement(control);
  refreshCreditsPlacement(control);
  return control;
}

export function renderComposerAgentControl(
  control: ComposerAgentControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: Partial<Record<ExternalRendererAgent, RendererAgentAvailability>> = {},
  modelView: ExternalModelControlView = { status: "idle" },
  permissionModeView: RendererPermissionModeControlView = { status: "idle" },
  usage: ThreadUsageSnapshot | null = null,
  accountCredits: AccountCreditsSnapshot | null = null,
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
  reconcileComposerNativeControls(
    control,
    pickerView.nativeModelHidden,
    switching || state.agent !== "codex",
  );
  syncRendererNativeContextUsage(control.nativeContextUsageControl?.element ?? null, usage);
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
  renderRendererCreditsControl(control.credits, accountCredits);
}

export function disposeComposerAgentControl(control: ComposerAgentControl): void {
  if (control.sendDisabledBeforeSwitch !== null) {
    control.sendButton.disabled = control.sendDisabledBeforeSwitch;
  }
  restoreNativeControl(control.nativeModelControl);
  clearRendererNativeContextUsage(control.nativeContextUsageControl?.element ?? null);
  restoreNativeControl(control.nativeContextUsageControl);
  restoreNativeControl(control.nativePermissionModeControl);
  control.credits.dispose();
  control.harnessCommands.dispose();
  control.permissionModePicker.dispose();
  control.modelPicker.dispose();
  control.picker.dispose();
}
