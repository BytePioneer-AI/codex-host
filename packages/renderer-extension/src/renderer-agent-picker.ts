import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
} from "./agent-group-preference.js";
import {
  isPickerAgentSelectable,
  type ComposerAgentPhase,
  type ExternalRendererAgent,
  type RendererAgent,
  type PickerAgentAvailability,
} from "./agent-selection-state.js";
import type { CodexAccountSummary, HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { createRendererAgentIcon, rendererAgentLabel } from "./renderer-agent-icon.js";
import { createSwapIcon } from "./renderer-handoff-view.js";
import {
  mountRendererModelSelectionNotice,
  type RendererModelSelectionNotice,
} from "./renderer-model-selection-notice.js";
import { requestConnectionsPageFocus } from "./settings/connections-page.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
} from "./settings/localization.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

// The picker's own strings (labels, tooltips, "Install ...") stay hardcoded
// English by longstanding convention in this file — only the newer
// Main/More grouping copy below is localized, since it mirrors text the
// user already sees (translated) on the Connections settings page.
function pickerGroupMessages(): Pick<
  ReturnType<typeof rendererSettingsMessages>,
  "locale" | "pickerMoreAgentsLabel" | "pickerManageLink" | "pickerHideUnusedAgentsCta"
> & {
  readonly ownershipErrorLabel: string;
  readonly handoffSectionLabel: string;
  readonly handoffHintLabel: string;
  readonly handoffSameLabel: (name: string) => string;
  readonly handoffTooltipSuffix: string;
} {
  const languages = typeof navigator !== "undefined" ? navigator.languages : [];
  const messages = rendererSettingsMessages(resolveRendererSettingsLocale(languages));
  const isZh = messages.locale === "zh-CN";
  return {
    ...messages,
    ownershipErrorLabel: isZh
      ? "无法确认会话的 Agent；重新聚焦窗口以重试"
      : "Unable to determine the Thread Agent; refocus the window to retry",
    handoffSectionLabel: isZh ? "交接上下文到新会话" : "Hand off to new conversation",
    handoffHintLabel: isZh
      ? "原会话保留只读，交接后在新会话继续。"
      : "Original stays read-only; continues in a new conversation.",
    handoffSameLabel: (name) => (isZh ? `用 ${name} 新开交接会话` : `New ${name} handoff`),
    handoffTooltipSuffix: isZh ? " · 上下文交接" : " · Context handoff",
  };
}

// Opens the Connections settings page from the picker's "More Agents" group.
// The shell installs this handle globally (see settings/shell.ts) as
// `window.__codexhostSettingsShellV1`; it is a no-op before the settings
// surface has mounted. Read through a local structural type instead of
// augmenting the global `Window` interface, so this stays a no-op import
// away from the settings module.
interface MinimalSettingsShellHandle {
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
}

function openSettingsPage(pageId: "connections", opener?: HTMLElement): void {
  const shell = (window as unknown as { __codexhostSettingsShellV1?: MinimalSettingsShellHandle })
    .__codexhostSettingsShellV1;
  shell?.openSettings(opener, pageId);
}

function openConnectionsSettings(opener?: HTMLElement): void {
  openSettingsPage("connections", opener);
}

type AgentAvailability = Partial<Record<ExternalRendererAgent, PickerAgentAvailability>>;

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";
const AGENT_MENU_WIDTH = 224;
// Below this many enabled Agents, the picker stays a flat list — grouping
// only earns its keep once there are enough Harnesses to make scanning slow.
const AGENT_GROUP_CTA_THRESHOLD = 5;

interface AgentOptionControl {
  row: HTMLElement;
  button: HTMLButtonElement;
  check: HTMLElement;
  swap: HTMLElement;
  // Shared 24x24 slot: renders as an Install ("+") action when the Agent is
  // not installed, or a red error ("!") action once it has failed — the two
  // are mutually exclusive since `RendererAgentAvailability` is a single
  // enum value. The error mode has no error *details* to show inline (the
  // picker only ever receives the coarse availability enum, not the full
  // `CodexhostError`), so it links out to Settings → Connections instead.
  action: HTMLButtonElement | null;
}

export interface RendererAgentPickerControl {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  iconSlot: HTMLElement;
  spinner: HTMLElement;
  ownershipError: HTMLElement;
  menu: HTMLElement;
  agents: readonly RendererAgent[];
  plugins: readonly HarnessPluginDescriptor[];
  options: Partial<Record<RendererAgent, AgentOptionControl>>;
  updateAvailability(availability: AgentAvailability): void;
  setBoundHandoff(agent: RendererAgent | null, showSameHandoff: boolean): void;
  showSwitchFailure(): void;
  close(): void;
  dispose(): void;
}

export interface RendererAgentPickerView {
  label: string;
  triggerDisabled: boolean;
  nativeModelHidden: boolean;
  optionDisabled: Partial<Record<RendererAgent, boolean>>;
  downloadVisible: Partial<Record<ExternalRendererAgent, boolean>>;
  /** True while availability is `error`. In-flight retries must keep that status, not flash back to `checking`. */
  errorVisible: Partial<Record<ExternalRendererAgent, boolean>>;
}

export function rendererAgentMenuPlacement(
  triggerRect: Pick<DOMRectReadOnly, "right" | "top">,
  viewport: { width: number; height: number },
  windowZoom: number,
): { left: number; bottom: number } {
  const zoom = Number.isFinite(windowZoom) && windowZoom > 0 ? windowZoom : 1;
  const viewportWidth = viewport.width / zoom;
  const viewportHeight = viewport.height / zoom;
  const left = Math.max(
    8,
    Math.min(triggerRect.right / zoom - AGENT_MENU_WIDTH, viewportWidth - AGENT_MENU_WIDTH - 8),
  );
  return {
    left,
    bottom: Math.max(8, viewportHeight - triggerRect.top / zoom + 6),
  };
}

export function rendererAgentPickerTooltip(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  activeAccount: CodexAccountSummary | undefined,
  plugin?: HarnessPluginDescriptor,
  handoffAvailable = false,
): string {
  const account =
    state.agent === "codex" && activeAccount
      ? ` · ${activeAccount.email ?? activeAccount.label}`
      : "";
  const suffix =
    state.phase === "locked"
      ? handoffAvailable
        ? pickerGroupMessages().handoffTooltipSuffix
        : " (locked)"
      : "";
  return `Agent: ${rendererAgentLabel(state.agent, plugin)}${account}${suffix}`;
}

export function rendererAgentPickerView(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  agents: readonly RendererAgent[],
  availability: AgentAvailability = {},
  plugin?: HarnessPluginDescriptor,
  handoffAvailable = false,
): RendererAgentPickerView {
  const boundHandoff = state.phase === "locked" && handoffAvailable;
  const optionDisabled = Object.fromEntries(
    agents.map((agent) => [
      agent,
      boundHandoff
        ? switching ||
          (agent !== state.agent &&
            agent !== "codex" &&
            (adapterState !== "ready" || !isPickerAgentSelectable(availability[agent])))
        : switching ||
          state.phase === "locked" ||
          (agent !== "codex" &&
            (adapterState !== "ready" || !isPickerAgentSelectable(availability[agent]))),
    ]),
  ) as Partial<Record<RendererAgent, boolean>>;
  const downloadVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "notInstalled"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  const errorVisible = Object.fromEntries(
    agents
      .filter((agent): agent is ExternalRendererAgent => agent !== "codex")
      .map((agent) => [agent, availability[agent] === "error"]),
  ) as Partial<Record<ExternalRendererAgent, boolean>>;
  return {
    label: rendererAgentLabel(state.agent, plugin),
    triggerDisabled:
      switching ||
      (state.phase === "locked" && !handoffAvailable) ||
      (state.phase === "draft" && agents.length < 2 && state.agent === "codex"),
    nativeModelHidden: switching || state.agent !== "codex",
    optionDisabled,
    downloadVisible,
    errorVisible,
  };
}

function setMenuPosition(control: RendererAgentPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const rawWindowZoom = getComputedStyle(document.documentElement)
    .getPropertyValue("--codex-window-zoom")
    .trim();
  const placement = rendererAgentMenuPlacement(
    rect,
    { width: window.innerWidth, height: window.innerHeight },
    Number.parseFloat(rawWindowZoom),
  );
  control.menu.style.left = `${placement.left}px`;
  control.menu.style.bottom = `${placement.bottom}px`;
}

function popoverOpen(menu: HTMLElement): boolean {
  try {
    return menu.matches(":popover-open");
  } catch {
    return !menu.hidden;
  }
}

export function mountRendererAgentPicker(
  composerId: string,
  enabledAgents: readonly RendererAgent[],
  onSelect: (agent: RendererAgent) => void,
  onDownload: (agent: ExternalRendererAgent) => void,
  onOpen?: () => void,
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
  plugins: readonly HarnessPluginDescriptor[] = [],
  onHandoff?: (agent: RendererAgent, anchor: HTMLButtonElement) => void,
): RendererAgentPickerControl {
  const root = document.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
  root.style.alignSelf = "center";
  root.style.verticalAlign = "middle";
  root.style.width = "30px";
  root.style.height = "28px";
  root.style.marginInline = "4px";
  root.style.color = "inherit";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.style.position = "relative";
  trigger.style.display = "inline-flex";
  trigger.style.alignItems = "center";
  trigger.style.justifyContent = "center";
  trigger.style.width = "30px";
  trigger.style.height = "28px";
  trigger.style.padding = "0";
  trigger.style.border = "0";
  trigger.style.borderRadius = "6px";
  trigger.style.background = "rgba(127, 127, 127, 0.08)";
  trigger.style.color = "inherit";
  trigger.style.cursor = "pointer";
  trigger.addEventListener("pointerenter", () => {
    if (!trigger.disabled) trigger.style.background = "rgba(127, 127, 127, 0.16)";
  });
  trigger.addEventListener("pointerleave", () => {
    trigger.style.background = "rgba(127, 127, 127, 0.08)";
  });

  const iconSlot = document.createElement("span");
  iconSlot.style.display = "inline-flex";
  iconSlot.style.alignItems = "center";
  iconSlot.style.justifyContent = "center";
  iconSlot.style.width = "20px";
  iconSlot.style.height = "20px";

  const spinner = document.createElement("span");
  spinner.setAttribute("aria-hidden", "true");
  spinner.style.display = "none";
  spinner.style.width = "16px";
  spinner.style.height = "16px";
  spinner.style.border = "2px solid currentColor";
  spinner.style.borderTopColor = "transparent";
  spinner.style.borderRadius = "50%";
  spinner.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
    duration: 800,
    iterations: Infinity,
  });
  const ownershipError = document.createElement("span");
  ownershipError.textContent = "!";
  ownershipError.setAttribute("aria-hidden", "true");
  ownershipError.style.display = "none";
  ownershipError.style.font = "bold 16px/1 system-ui, sans-serif";
  trigger.append(iconSlot, spinner, ownershipError);

  const menu = document.createElement("div");
  menu.id = `${composerId}-agent-menu`;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Agent");
  menu.setAttribute("popover", "auto");
  menu.hidden = typeof menu.showPopover !== "function";
  menu.style.position = "fixed";
  menu.style.inset = "auto";
  menu.style.width = `${AGENT_MENU_WIDTH}px`;
  menu.style.padding = "4px";
  menu.style.border = "0";
  menu.style.borderRadius = "6px";
  menu.style.background = "Canvas";
  menu.style.color = "CanvasText";
  menu.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.28)";
  menu.style.boxSizing = "border-box";
  menu.style.maxHeight = "min(420px, calc(100vh - 16px))";
  menu.style.overflowX = "hidden";
  menu.style.overflowY = "auto";
  menu.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", menu.id);

  const options: Partial<Record<RendererAgent, AgentOptionControl>> = {};
  const rowsByAgent = new Map<RendererAgent, HTMLDivElement>();
  const groupMessages = pickerGroupMessages();
  let switchFailureNotice: RendererModelSelectionNotice | undefined;
  let boundHandoffAgent: RendererAgent | null = null;
  let showSameHandoff = false;

  let moreOpen = false;
  let regroupMenu: (() => void) | null = null;
  const close = (): void => {
    if (!popoverOpen(menu)) return;
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (moreOpen) {
      moreOpen = false;
      regroupMenu?.();
    }
  };
  const focusOption = (position: "first" | "last" | "selected"): void => {
    const available = [
      ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'),
    ].filter((button) => !button.disabled && !button.closest<HTMLElement>("[hidden]"));
    const selected = available.find((button) => button.getAttribute("aria-checked") === "true");
    const target =
      position === "last" ? available.at(-1) : position === "selected" ? selected : available[0];
    target?.focus();
  };
  const open = (focus: "first" | "last" | "selected" = "selected"): void => {
    switchFailureNotice?.hide();
    if (trigger.disabled || popoverOpen(menu)) return;
    setMenuPosition(control);
    if (typeof menu.showPopover === "function") menu.showPopover();
    else menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen?.();
    queueMicrotask(() => focusOption(focus));
  };

  for (const agent of enabledAgents) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.agent = agent;
    button.setAttribute("role", "menuitemradio");
    button.style.display = "flex";
    button.style.alignItems = "center";
    button.style.gap = "8px";
    button.style.minWidth = "0";
    button.style.width = "100%";
    button.style.flex = "1 1 auto";
    button.style.height = "36px";
    button.style.padding = "0 34px 0 8px";
    button.style.border = "0";
    button.style.borderRadius = "4px";
    button.style.background = "transparent";
    button.style.color = "inherit";
    button.style.font = "500 13px/1 system-ui, sans-serif";
    button.style.letterSpacing = "0";
    button.style.textAlign = "left";
    button.style.cursor = "pointer";
    const updateHighlight = (active: boolean): void => {
      const selected = button.getAttribute("aria-checked") === "true";
      button.style.background =
        selected || (active && !button.disabled)
          ? `rgba(127, 127, 127, ${selected ? "0.16" : "0.1"})`
          : "transparent";
    };
    button.addEventListener("pointerenter", () => updateHighlight(true));
    button.addEventListener("pointerleave", () => updateHighlight(false));
    button.addEventListener("focus", () => updateHighlight(true));
    button.addEventListener("blur", () => updateHighlight(false));

    const check = document.createElement("span");
    check.textContent = "\u2713";
    check.setAttribute("aria-hidden", "true");
    check.style.position = "absolute";
    check.style.inset = "0";
    check.style.display = "inline-flex";
    check.style.alignItems = "center";
    check.style.justifyContent = "center";
    check.style.visibility = "hidden";

    const swap = document.createElement("span");
    swap.setAttribute("aria-hidden", "true");
    swap.style.position = "absolute";
    swap.style.inset = "0";
    swap.style.display = "inline-flex";
    swap.style.alignItems = "center";
    swap.style.justifyContent = "center";
    swap.style.opacity = "0.55";
    swap.style.visibility = "hidden";
    swap.append(createSwapIcon(document, 14));

    const label = document.createElement("span");
    const plugin = plugins.find(({ id }) => id === agent);
    label.textContent = rendererAgentLabel(agent, plugin);
    label.style.minWidth = "0";
    label.style.flex = "1 1 auto";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";
    button.append(createRendererAgentIcon(agent, 20, document, plugin), label);
    button.addEventListener("click", () => {
      if (boundHandoffAgent !== null) {
        close();
        if (agent === boundHandoffAgent) {
          trigger.focus();
        } else {
          onHandoff?.(agent, trigger);
        }
        return;
      }
      const selected = button.getAttribute("aria-pressed") === "true";
      close();
      trigger.focus();
      if (!selected) onSelect(agent);
    });

    const action =
      agent === "codex"
        ? null
        : (() => {
            const control = document.createElement("button");
            control.type = "button";
            control.style.position = "absolute";
            control.style.inset = "0";
            control.style.display = "inline-flex";
            control.style.alignItems = "center";
            control.style.justifyContent = "center";
            control.style.width = "24px";
            control.style.height = "24px";
            control.style.flex = "none";
            control.style.padding = "0";
            control.style.border = "0";
            control.style.borderRadius = "4px";
            control.style.background = "transparent";
            control.style.cursor = "pointer";
            control.addEventListener("pointerenter", () => {
              if (!control.disabled) control.style.background = "rgba(127, 127, 127, 0.16)";
            });
            control.addEventListener("pointerleave", () => {
              control.style.background = "transparent";
            });
            control.addEventListener("click", (event) => {
              event.stopPropagation();
              // "error" mode has nothing more to show inline — the picker
              // only knows the coarse availability enum, not the full
              // `CodexhostError` — so it hands off to Settings, which does.
              // `requestConnectionsPageFocus` makes sure Settings opens
              // straight to *this* Agent's row, not just the page.
              if (control.dataset.mode === "error") {
                requestConnectionsPageFocus(agent);
                openConnectionsSettings(trigger);
              } else {
                onDownload(agent);
              }
            });
            return control;
          })();
    const row = document.createElement("div");
    row.style.position = "relative";
    row.style.display = "flex";
    row.style.alignItems = "center";
    const actionSlot = document.createElement("span");
    actionSlot.style.position = "absolute";
    actionSlot.style.top = "6px";
    actionSlot.style.right = "4px";
    actionSlot.style.zIndex = "1";
    actionSlot.style.display = "inline-block";
    actionSlot.style.width = "24px";
    actionSlot.style.height = "24px";
    actionSlot.style.pointerEvents = "none";
    actionSlot.append(check, swap);
    if (action) actionSlot.append(action);
    row.append(button, actionSlot);
    options[agent] = { row, button, check, swap, action };
    rowsByAgent.set(agent, row);
  }

  const boundCurrentGroup = document.createElement("div");
  boundCurrentGroup.style.display = "none";
  boundCurrentGroup.style.flexDirection = "column";
  boundCurrentGroup.style.gap = "2px";

  const handoffSeparator = document.createElement("div");
  handoffSeparator.setAttribute("role", "separator");
  handoffSeparator.style.display = "none";
  handoffSeparator.style.height = "1px";
  handoffSeparator.style.margin = "4px 2px";
  handoffSeparator.style.background = "rgba(127, 127, 127, 0.16)";

  const handoffHeading = document.createElement("div");
  handoffHeading.setAttribute("role", "presentation");
  handoffHeading.textContent = groupMessages.handoffSectionLabel;
  handoffHeading.style.display = "none";
  handoffHeading.style.padding = "4px 8px";
  handoffHeading.style.font = "400 11px/15px system-ui, sans-serif";
  handoffHeading.style.opacity = "0.62";

  const sameHandoffRow = document.createElement("div");
  sameHandoffRow.style.position = "relative";
  sameHandoffRow.style.display = "none";
  sameHandoffRow.style.alignItems = "center";
  const sameHandoffButton = document.createElement("button");
  sameHandoffButton.type = "button";
  sameHandoffButton.setAttribute("role", "menuitem");
  sameHandoffButton.style.display = "flex";
  sameHandoffButton.style.alignItems = "center";
  sameHandoffButton.style.gap = "8px";
  sameHandoffButton.style.minWidth = "0";
  sameHandoffButton.style.width = "100%";
  sameHandoffButton.style.height = "36px";
  sameHandoffButton.style.padding = "0 34px 0 8px";
  sameHandoffButton.style.border = "0";
  sameHandoffButton.style.borderRadius = "4px";
  sameHandoffButton.style.background = "transparent";
  sameHandoffButton.style.color = "inherit";
  sameHandoffButton.style.font = "500 13px/1 system-ui, sans-serif";
  sameHandoffButton.style.textAlign = "left";
  sameHandoffButton.style.cursor = "pointer";
  sameHandoffButton.addEventListener("pointerenter", () => {
    sameHandoffButton.style.background = "rgba(127, 127, 127, 0.1)";
  });
  sameHandoffButton.addEventListener("pointerleave", () => {
    sameHandoffButton.style.background = "transparent";
  });
  sameHandoffButton.addEventListener("focus", () => {
    sameHandoffButton.style.background = "rgba(127, 127, 127, 0.1)";
  });
  sameHandoffButton.addEventListener("blur", () => {
    sameHandoffButton.style.background = "transparent";
  });
  const sameHandoffIconSlot = document.createElement("span");
  sameHandoffIconSlot.style.display = "inline-flex";
  sameHandoffIconSlot.style.alignItems = "center";
  sameHandoffIconSlot.style.justifyContent = "center";
  sameHandoffIconSlot.style.width = "20px";
  sameHandoffIconSlot.style.height = "20px";
  sameHandoffIconSlot.style.flex = "none";
  const sameHandoffLabel = document.createElement("span");
  sameHandoffLabel.style.minWidth = "0";
  sameHandoffLabel.style.flex = "1 1 auto";
  sameHandoffLabel.style.overflow = "hidden";
  sameHandoffLabel.style.textOverflow = "ellipsis";
  sameHandoffLabel.style.whiteSpace = "nowrap";
  sameHandoffButton.append(sameHandoffIconSlot, sameHandoffLabel);
  sameHandoffButton.addEventListener("click", () => {
    const current = boundHandoffAgent;
    close();
    if (current) onHandoff?.(current, trigger);
  });
  const sameHandoffSwapSlot = document.createElement("span");
  sameHandoffSwapSlot.setAttribute("aria-hidden", "true");
  sameHandoffSwapSlot.style.position = "absolute";
  sameHandoffSwapSlot.style.top = "6px";
  sameHandoffSwapSlot.style.right = "4px";
  sameHandoffSwapSlot.style.display = "inline-flex";
  sameHandoffSwapSlot.style.alignItems = "center";
  sameHandoffSwapSlot.style.justifyContent = "center";
  sameHandoffSwapSlot.style.width = "24px";
  sameHandoffSwapSlot.style.height = "24px";
  sameHandoffSwapSlot.style.opacity = "0.55";
  sameHandoffSwapSlot.style.pointerEvents = "none";
  sameHandoffSwapSlot.append(createSwapIcon(document, 14));
  sameHandoffRow.append(sameHandoffButton, sameHandoffSwapSlot);

  const handoffFooter = document.createElement("div");
  handoffFooter.setAttribute("role", "presentation");
  handoffFooter.textContent = groupMessages.handoffHintLabel;
  handoffFooter.style.display = "none";
  handoffFooter.style.marginTop = "4px";
  handoffFooter.style.padding = "6px 8px 4px";
  handoffFooter.style.borderTop = "1px solid rgba(127, 127, 127, 0.16)";
  handoffFooter.style.font = "400 11px/15px system-ui, sans-serif";
  handoffFooter.style.opacity = "0.62";
  handoffFooter.style.whiteSpace = "normal";

  // "Main" holds every enabled Agent by default; a user can fold the ones
  // they never switch to into "More" from the Connections settings page.
  // Codex always stays pinned to Main — it is the always-on default and is
  // not offered in Connections' grouping list.
  const mainGroup = document.createElement("div");
  mainGroup.style.display = "flex";
  mainGroup.style.flexDirection = "column";
  mainGroup.style.gap = "2px";
  const moreToggle = document.createElement("button");
  moreToggle.type = "button";
  moreToggle.style.display = "none";
  moreToggle.style.alignItems = "center";
  moreToggle.style.gap = "6px";
  moreToggle.style.width = "100%";
  moreToggle.style.height = "32px";
  moreToggle.style.marginTop = "2px";
  moreToggle.style.padding = "0 8px";
  moreToggle.style.border = "0";
  moreToggle.style.borderRadius = "4px";
  moreToggle.style.background = "transparent";
  moreToggle.style.color = "inherit";
  moreToggle.style.font = "500 12px/1 system-ui, sans-serif";
  moreToggle.style.opacity = "0.72";
  moreToggle.style.cursor = "pointer";
  moreToggle.addEventListener("pointerenter", () => {
    moreToggle.style.background = "rgba(127, 127, 127, 0.1)";
  });
  moreToggle.addEventListener("pointerleave", () => {
    moreToggle.style.background = "transparent";
  });
  const moreArrow = document.createElement("span");
  moreArrow.setAttribute("aria-hidden", "true");
  moreArrow.style.width = "12px";
  moreArrow.style.flex = "none";
  moreArrow.textContent = "▸";
  const moreLabel = document.createElement("span");
  moreToggle.append(moreArrow, moreLabel);

  const morePanel = document.createElement("div");
  morePanel.style.display = "none";
  morePanel.style.flexDirection = "column";
  morePanel.style.gap = "2px";
  morePanel.style.paddingLeft = "8px";
  const moreRows = document.createElement("div");
  moreRows.style.display = "flex";
  moreRows.style.flexDirection = "column";
  moreRows.style.gap = "2px";
  const manageLink = document.createElement("button");
  manageLink.type = "button";
  manageLink.textContent = `${groupMessages.pickerManageLink} →`;
  manageLink.style.display = "flex";
  manageLink.style.width = "100%";
  manageLink.style.height = "28px";
  manageLink.style.marginTop = "2px";
  manageLink.style.padding = "0 12px";
  manageLink.style.border = "0";
  manageLink.style.borderRadius = "4px";
  manageLink.style.background = "transparent";
  manageLink.style.color = "#6d9fff";
  manageLink.style.font = "500 11px/1 system-ui, sans-serif";
  manageLink.style.cursor = "pointer";
  manageLink.addEventListener("click", () => openConnectionsSettings(trigger));
  morePanel.append(moreRows, manageLink);

  const cta = document.createElement("button");
  cta.type = "button";
  cta.style.display = "none";
  cta.style.alignItems = "center";
  cta.style.gap = "6px";
  cta.style.width = "100%";
  cta.style.height = "32px";
  cta.style.marginTop = "2px";
  cta.style.padding = "0 8px";
  cta.style.borderWidth = "1px 0 0 0";
  cta.style.borderStyle = "solid";
  cta.style.borderColor = "rgba(127, 127, 127, 0.16)";
  cta.style.background = "transparent";
  cta.style.color = "inherit";
  cta.style.font = "500 12px/1 system-ui, sans-serif";
  cta.style.opacity = "0.72";
  cta.style.cursor = "pointer";
  cta.textContent = `⚙ ${groupMessages.pickerHideUnusedAgentsCta} →`;
  cta.addEventListener("pointerenter", () => {
    cta.style.background = "rgba(127, 127, 127, 0.1)";
  });
  cta.addEventListener("pointerleave", () => {
    cta.style.background = "transparent";
  });
  cta.addEventListener("click", () => openConnectionsSettings(trigger));

  let notInstalled = new Set<RendererAgent>();
  let mainAgents: RendererAgent[] = [...enabledAgents];
  let moreAgents: RendererAgent[] = [];
  const regroup = (): void => {
    const enabledSet = new Set(enabledAgents);
    const seen = new Set<RendererAgent>();
    const nextMain: RendererAgent[] = [];
    const nextMore: RendererAgent[] = [];

    // Codex is always pinned to Main and isn't tracked by the preference
    // store (it's the always-on default, not offered in Connections'
    // grouping list). In bound-handoff mode, the current Agent is pinned above
    // the handoff divider instead of appearing inside Main/More.
    if (boundHandoffAgent !== null) {
      seen.add(boundHandoffAgent);
    }
    if (enabledSet.has("codex") && !seen.has("codex")) {
      nextMain.push("codex");
      seen.add("codex");
    }

    // Order follows `groupPreference.list()` — the same order the user just
    // dragged into on the Connections page — not `enabledAgents`'s fixed
    // (host-configured) order, so reordering actually shows up here too.
    const catalog = enabledAgents.map((id) => ({
      id,
      name: plugins.find((plugin) => plugin.id === id)?.name ?? id,
    }));
    for (const entry of groupPreference.list(notInstalled, catalog)) {
      const agent = entry.agent as RendererAgent;
      if (!enabledSet.has(agent) || seen.has(agent)) continue;
      seen.add(agent);
      const section = groupPreference.sectionOf(entry.agent, notInstalled.has(agent));
      (section === "more" ? nextMore : nextMain).push(agent);
    }

    // Defensive: an enabled Agent the preference store hasn't recorded yet
    // (should not normally happen) still needs to render somewhere.
    for (const agent of enabledAgents) {
      if (seen.has(agent)) continue;
      seen.add(agent);
      nextMain.push(agent);
    }

    // Stable sorting preserves the default/custom order within each section.
    // Only confirmed missing installations move back, not checking/error states.
    const installationOrder = (a: RendererAgent, b: RendererAgent): number =>
      Number(notInstalled.has(a)) - Number(notInstalled.has(b));
    mainAgents = nextMain.sort(installationOrder);
    moreAgents = nextMore.sort(installationOrder);
    const boundRow = boundHandoffAgent ? rowsByAgent.get(boundHandoffAgent) : undefined;
    boundCurrentGroup.replaceChildren(...(boundRow ? [boundRow] : []));
    boundCurrentGroup.style.display = boundRow ? "flex" : "none";

    const mainChildren: HTMLElement[] = [];
    for (const agent of mainAgents) {
      const row = rowsByAgent.get(agent);
      if (row) mainChildren.push(row);
    }
    mainGroup.replaceChildren(...mainChildren);
    moreRows.replaceChildren(
      ...moreAgents
        .map((agent) => rowsByAgent.get(agent))
        .filter((el): el is HTMLDivElement => !!el),
    );
    const hasSecondaryRows = mainAgents.length > 0 || moreAgents.length > 0 || showSameHandoff;
    handoffSeparator.style.display = boundRow && hasSecondaryRows ? "block" : "none";
    handoffHeading.style.display = boundHandoffAgent && hasSecondaryRows ? "block" : "none";
    if (boundHandoffAgent && showSameHandoff) {
      const plugin = plugins.find(({ id }) => id === boundHandoffAgent);
      sameHandoffIconSlot.replaceChildren(
        createRendererAgentIcon(boundHandoffAgent, 20, document, plugin),
      );
      sameHandoffLabel.textContent = groupMessages.handoffSameLabel(
        rendererAgentLabel(boundHandoffAgent, plugin),
      );
      sameHandoffRow.style.display = "flex";
    } else {
      sameHandoffRow.style.display = "none";
    }
    handoffFooter.style.display = boundHandoffAgent ? "block" : "none";
    const showMoreGroup = moreAgents.length > 0;
    const showCta = !showMoreGroup && enabledAgents.length > AGENT_GROUP_CTA_THRESHOLD;
    moreToggle.style.display = showMoreGroup ? "flex" : "none";
    morePanel.style.display = showMoreGroup && moreOpen ? "flex" : "none";
    cta.style.display = showCta ? "flex" : "none";
    moreLabel.textContent = `${groupMessages.pickerMoreAgentsLabel} (${moreAgents.length})`;
    moreArrow.textContent = moreOpen ? "▾" : "▸";
  };
  regroupMenu = regroup;
  moreToggle.addEventListener("click", () => {
    moreOpen = !moreOpen;
    regroup();
  });
  regroup();
  const unsubscribeGroup = groupPreference.subscribe(regroup);

  menu.append(
    boundCurrentGroup,
    handoffSeparator,
    handoffHeading,
    sameHandoffRow,
    mainGroup,
    moreToggle,
    morePanel,
    cta,
    handoffFooter,
  );
  root.append(trigger, menu);

  const onTriggerClick = (): void => {
    if (popoverOpen(menu)) close();
    else open();
  };
  const onTriggerKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open(event.key === "ArrowUp" ? "last" : "first");
  };
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    const buttons = [
      ...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]'),
    ].filter((button) => !button.disabled && !button.closest<HTMLElement>("[hidden]"));
    const current = event.target instanceof Element ? event.target.closest("button") : null;
    const index = buttons.indexOf(current as HTMLButtonElement);
    if (event.key === "Escape") {
      close();
      trigger.focus();
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : event.key === "ArrowDown"
            ? buttons[(index + 1 + buttons.length) % buttons.length]
            : buttons[(index - 1 + buttons.length) % buttons.length];
    target?.focus();
  };
  const onToggle = (): void => {
    trigger.setAttribute("aria-expanded", String(popoverOpen(menu)));
  };
  const onViewportChange = (): void => {
    if (popoverOpen(menu)) setMenuPosition(control);
  };
  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onTriggerKeyDown);
  menu.addEventListener("keydown", onMenuKeyDown);
  menu.addEventListener("toggle", onToggle);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  const control: RendererAgentPickerControl = {
    root,
    trigger,
    iconSlot,
    spinner,
    ownershipError,
    menu,
    agents: [...enabledAgents],
    plugins,
    options,
    updateAvailability(availability) {
      const next = new Set(
        enabledAgents.filter(
          (agent) => agent !== "codex" && availability[agent] === "notInstalled",
        ),
      );
      if (next.size === notInstalled.size && [...next].every((agent) => notInstalled.has(agent))) {
        return;
      }
      notInstalled = next;
      regroup();
    },
    setBoundHandoff(agent, sameHandoff) {
      if (boundHandoffAgent === agent && showSameHandoff === sameHandoff) return;
      boundHandoffAgent = agent;
      showSameHandoff = sameHandoff;
      regroup();
    },
    showSwitchFailure() {
      switchFailureNotice ??= mountRendererModelSelectionNotice(trigger);
      if (groupMessages.locale === "zh-CN") {
        switchFailureNotice.show("无法切换 Agent", "当前草稿暂时无法使用所选 Agent。");
      } else {
        switchFailureNotice.show(
          "Couldn’t switch Agent",
          "The selected Agent isn’t available for this draft.",
        );
      }
    },
    close,
    dispose() {
      close();
      switchFailureNotice?.dispose();
      unsubscribeGroup();
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onTriggerKeyDown);
      menu.removeEventListener("keydown", onMenuKeyDown);
      menu.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      root.remove();
    },
  };
  return control;
}

export function renderRendererAgentPicker(
  control: RendererAgentPickerControl,
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  availability: AgentAvailability = {},
  currentCodexAccount: CodexAccountSummary | null = null,
  ownershipError = false,
  handoffAvailable = false,
): RendererAgentPickerView {
  const effectiveHandoff = handoffAvailable && !ownershipError;
  const view = rendererAgentPickerView(
    state,
    adapterState,
    switching,
    control.agents,
    availability,
    control.plugins.find(({ id }) => id === state.agent),
    effectiveHandoff,
  );
  const boundHandoff = state.phase === "locked" && effectiveHandoff;
  const hasOtherReady =
    boundHandoff &&
    control.agents.some((agent) => agent !== state.agent && !(view.optionDisabled[agent] ?? true));
  control.updateAvailability(availability);
  control.setBoundHandoff(boundHandoff ? state.agent : null, boundHandoff && !hasOtherReady);
  if (control.iconSlot.dataset.agent !== state.agent) {
    control.iconSlot.replaceChildren(
      createRendererAgentIcon(
        state.agent,
        20,
        document,
        control.plugins.find(({ id }) => id === state.agent),
      ),
    );
    control.iconSlot.dataset.agent = state.agent;
  }
  control.trigger.disabled = view.triggerDisabled || ownershipError;
  control.trigger.setAttribute("aria-busy", String(switching));
  control.trigger.setAttribute(
    "aria-label",
    ownershipError
      ? pickerGroupMessages().ownershipErrorLabel
      : state.phase === "locked" && !effectiveHandoff
        ? `Agent: ${view.label}`
        : `Select Agent, current ${view.label}`,
  );
  control.trigger.title = ownershipError
    ? pickerGroupMessages().ownershipErrorLabel
    : rendererAgentPickerTooltip(
        state,
        currentCodexAccount ?? undefined,
        control.plugins.find(({ id }) => id === state.agent),
        effectiveHandoff,
      );
  control.trigger.style.cursor = control.trigger.disabled ? "not-allowed" : "pointer";
  control.trigger.style.opacity = control.trigger.disabled && !switching ? "0.72" : "1";
  control.iconSlot.style.display = switching || ownershipError ? "none" : "inline-flex";
  control.spinner.style.display = switching ? "block" : "none";
  control.ownershipError.style.display = ownershipError && !switching ? "block" : "none";
  if (control.trigger.disabled) control.close();

  for (const agent of control.agents) {
    const option = control.options[agent];
    if (!option) continue;
    const selected = agent === state.agent;
    const externalAgent = agent !== "codex" ? (agent as ExternalRendererAgent) : null;
    const showInstall = externalAgent !== null && view.downloadVisible[externalAgent] === true;
    const showError = externalAgent !== null && view.errorVisible[externalAgent] === true;
    const actionVisible = showInstall || showError;
    option.button.disabled = view.optionDisabled[agent] ?? true;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.setAttribute("aria-pressed", String(selected));
    option.button.style.background = selected ? "rgba(127, 127, 127, 0.16)" : "transparent";
    option.button.style.cursor = option.button.disabled ? "not-allowed" : "pointer";
    option.button.style.opacity = option.button.disabled && !selected ? "0.5" : "1";
    option.check.style.visibility = selected ? "visible" : "hidden";
    option.swap.style.visibility =
      boundHandoff && !selected && !option.button.disabled && !actionVisible ? "visible" : "hidden";
    if (option.action) {
      const visible = actionVisible;
      option.action.hidden = false;
      option.action.disabled = !visible;
      option.action.style.display = "inline-flex";
      option.action.style.visibility = visible ? "visible" : "hidden";
      option.action.style.pointerEvents = visible ? "auto" : "none";
      if (showError) {
        option.action.dataset.mode = "error";
        option.action.textContent = "!";
        option.action.style.color = "#f87171";
        option.action.style.font = "800 13px/1 system-ui, sans-serif";
        option.action.style.opacity = "1";
        const label = `${rendererAgentLabel(
          agent,
          control.plugins.find(({ id }) => id === agent),
        )} connection error — open Settings for details`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      } else {
        option.action.dataset.mode = "install";
        option.action.textContent = "+";
        option.action.style.color = "inherit";
        option.action.style.font = "600 18px/1 system-ui, sans-serif";
        option.action.style.opacity = "0.72";
        const label = `Install ${rendererAgentLabel(
          agent,
          control.plugins.find(({ id }) => id === agent),
        )}`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      }
      option.action.setAttribute("aria-hidden", String(!visible));
    }
  }
  return view;
}
