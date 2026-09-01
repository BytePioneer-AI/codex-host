import {
  getSharedAgentGroupPreferenceStore,
  type AgentGroupPreferenceStore,
} from "./agent-group-preference.js";
import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
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
  "pickerMoreAgentsLabel" | "pickerManageLink" | "pickerHideUnusedAgentsCta"
> {
  const languages = typeof navigator !== "undefined" ? navigator.languages : [];
  return rendererSettingsMessages(resolveRendererSettingsLocale(languages));
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

function openConnectionsSettings(opener?: HTMLElement): void {
  const shell = (window as unknown as { __codexhostSettingsShellV1?: MinimalSettingsShellHandle })
    .__codexhostSettingsShellV1;
  shell?.openSettings(opener, "connections");
}

export const RENDERER_AGENT_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = {
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://github.com/deepseek-ai/deepseek-harness",
  opencode: "https://opencode.ai/docs/",
  grok: "https://grok.com/",
  omp: "https://github.com/can1357/oh-my-pi",
};

type AgentAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";
const AGENT_MENU_WIDTH = 200;
// Below this many enabled Agents, the picker stays a flat list — grouping
// only earns its keep once there are enough Harnesses to make scanning slow.
const AGENT_GROUP_CTA_THRESHOLD = 5;

interface AgentOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
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
  menu: HTMLElement;
  agents: readonly RendererAgent[];
  options: Partial<Record<RendererAgent, AgentOptionControl>>;
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

export function rendererAgentPickerView(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  agents: readonly RendererAgent[],
  availability: AgentAvailability = {},
): RendererAgentPickerView {
  const optionDisabled = Object.fromEntries(
    agents.map((agent) => [
      agent,
      switching ||
        state.phase === "locked" ||
        (agent !== "codex" && (adapterState !== "ready" || availability[agent] !== "ready")),
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
    label: RENDERER_AGENT_LABELS[state.agent],
    triggerDisabled: switching || state.phase === "locked" || agents.length < 2,
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
  groupPreference: AgentGroupPreferenceStore = getSharedAgentGroupPreferenceStore(),
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
  trigger.append(iconSlot, spinner);

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
  menu.style.overflowX = "hidden";
  menu.style.overflowY = "auto";
  menu.style.zIndex = "2147483647";
  trigger.setAttribute("aria-controls", menu.id);

  const options: Partial<Record<RendererAgent, AgentOptionControl>> = {};
  const rowsByAgent = new Map<RendererAgent, HTMLDivElement>();
  const groupMessages = pickerGroupMessages();

  const close = (): void => {
    if (!popoverOpen(menu)) return;
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const visibleAgentOrder = (): readonly RendererAgent[] =>
    moreOpen ? [...mainAgents, ...moreAgents] : mainAgents;
  const focusOption = (position: "first" | "last" | "selected"): void => {
    const available = visibleAgentOrder()
      .map((agent) => options[agent]?.button)
      .filter((button): button is HTMLButtonElement => button !== undefined && !button.disabled);
    const selected = available.find((button) => button.getAttribute("aria-checked") === "true");
    const target =
      position === "last" ? available.at(-1) : position === "selected" ? selected : available[0];
    target?.focus();
  };
  const open = (focus: "first" | "last" | "selected" = "selected"): void => {
    if (trigger.disabled || popoverOpen(menu)) return;
    setMenuPosition(control);
    if (typeof menu.showPopover === "function") menu.showPopover();
    else menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
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
    button.style.padding = "0 8px";
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
    check.style.width = "24px";
    check.style.flex = "none";
    check.style.textAlign = "center";
    check.style.visibility = "hidden";

    const label = document.createElement("span");
    label.textContent = RENDERER_AGENT_LABELS[agent];
    label.style.minWidth = "0";
    label.style.flex = "1 1 auto";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";
    button.append(createRendererAgentIcon(agent), label);
    button.addEventListener("click", () => {
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
    options[agent] = { button, check, action };
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "2px";
    const actionSlot = document.createElement("span");
    actionSlot.style.position = "relative";
    actionSlot.style.display = "inline-block";
    actionSlot.style.width = "24px";
    actionSlot.style.height = "24px";
    actionSlot.style.flex = "none";
    actionSlot.append(check);
    if (action) actionSlot.append(action);
    row.append(actionSlot, button);
    rowsByAgent.set(agent, row);
  }

  // "Main" holds every enabled Agent by default; a user can fold the ones
  // they never switch to into "More" from the Connections settings page.
  // Codex always stays pinned to Main — it is the always-on default and is
  // not offered in Connections' grouping list.
  const mainGroup = document.createElement("div");
  mainGroup.style.display = "flex";
  mainGroup.style.flexDirection = "column";
  mainGroup.style.gap = "2px";

  let moreOpen = false;
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

  let mainAgents: RendererAgent[] = [...enabledAgents];
  let moreAgents: RendererAgent[] = [];
  const regroup = (): void => {
    const enabledSet = new Set(enabledAgents);
    const seen = new Set<RendererAgent>();
    const nextMain: RendererAgent[] = [];
    const nextMore: RendererAgent[] = [];

    // Codex is always pinned to Main and isn't tracked by the preference
    // store (it's the always-on default, not offered in Connections'
    // grouping list).
    if (enabledSet.has("codex")) {
      nextMain.push("codex");
      seen.add("codex");
    }

    // Order follows `groupPreference.list()` — the same order the user just
    // dragged into on the Connections page — not `enabledAgents`'s fixed
    // (host-configured) order, so reordering actually shows up here too.
    for (const entry of groupPreference.list()) {
      const agent = entry.agent as RendererAgent;
      if (!enabledSet.has(agent) || seen.has(agent)) continue;
      seen.add(agent);
      (entry.section === "more" ? nextMore : nextMain).push(agent);
    }

    // Defensive: an enabled Agent the preference store hasn't recorded yet
    // (should not normally happen) still needs to render somewhere.
    for (const agent of enabledAgents) {
      if (seen.has(agent)) continue;
      seen.add(agent);
      nextMain.push(agent);
    }

    mainAgents = nextMain;
    moreAgents = nextMore;
    mainGroup.replaceChildren(
      ...mainAgents
        .map((agent) => rowsByAgent.get(agent))
        .filter((el): el is HTMLDivElement => !!el),
    );
    moreRows.replaceChildren(
      ...moreAgents
        .map((agent) => rowsByAgent.get(agent))
        .filter((el): el is HTMLDivElement => !!el),
    );
    const showMoreGroup = moreAgents.length > 0;
    const showCta = !showMoreGroup && enabledAgents.length > AGENT_GROUP_CTA_THRESHOLD;
    moreToggle.style.display = showMoreGroup ? "flex" : "none";
    morePanel.style.display = showMoreGroup && moreOpen ? "flex" : "none";
    cta.style.display = showCta ? "flex" : "none";
    moreLabel.textContent = `${groupMessages.pickerMoreAgentsLabel} (${moreAgents.length})`;
    moreArrow.textContent = moreOpen ? "▾" : "▸";
  };
  moreToggle.addEventListener("click", () => {
    moreOpen = !moreOpen;
    regroup();
  });
  regroup();
  const unsubscribeGroup = groupPreference.subscribe(regroup);

  menu.append(mainGroup, moreToggle, morePanel, cta);
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
    const buttons = visibleAgentOrder()
      .map((agent) => options[agent]?.button)
      .filter((button): button is HTMLButtonElement => button !== undefined && !button.disabled);
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
    menu,
    agents: [...enabledAgents],
    options,
    close,
    dispose() {
      close();
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
): RendererAgentPickerView {
  const view = rendererAgentPickerView(
    state,
    adapterState,
    switching,
    control.agents,
    availability,
  );
  if (control.iconSlot.dataset.agent !== state.agent) {
    control.iconSlot.replaceChildren(createRendererAgentIcon(state.agent));
    control.iconSlot.dataset.agent = state.agent;
  }
  control.trigger.disabled = view.triggerDisabled;
  control.trigger.setAttribute("aria-busy", String(switching));
  control.trigger.setAttribute(
    "aria-label",
    state.phase === "locked" ? `Agent: ${view.label}` : `Select Agent, current ${view.label}`,
  );
  control.trigger.title =
    state.phase === "locked" ? `Agent: ${view.label} (locked)` : `Agent: ${view.label}`;
  control.trigger.style.cursor = control.trigger.disabled ? "not-allowed" : "pointer";
  control.trigger.style.opacity = control.trigger.disabled && !switching ? "0.72" : "1";
  control.iconSlot.style.display = switching ? "none" : "inline-flex";
  control.spinner.style.display = switching ? "block" : "none";
  if (view.triggerDisabled) control.close();

  for (const agent of control.agents) {
    const option = control.options[agent];
    if (!option) continue;
    const selected = agent === state.agent;
    option.button.disabled = view.optionDisabled[agent] ?? true;
    option.button.setAttribute("aria-checked", String(selected));
    option.button.setAttribute("aria-pressed", String(selected));
    option.button.style.background = selected ? "rgba(127, 127, 127, 0.16)" : "transparent";
    option.button.style.cursor = option.button.disabled ? "not-allowed" : "pointer";
    option.button.style.opacity = option.button.disabled && !selected ? "0.5" : "1";
    option.check.style.visibility = selected ? "visible" : "hidden";
    if (option.action) {
      const externalAgent = agent as ExternalRendererAgent;
      const showInstall = view.downloadVisible[externalAgent] === true;
      const showError = view.errorVisible[externalAgent] === true;
      const visible = showInstall || showError;
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
        const label = `${RENDERER_AGENT_LABELS[agent]} connection error — open Settings for details`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      } else {
        option.action.dataset.mode = "install";
        option.action.textContent = "+";
        option.action.style.color = "inherit";
        option.action.style.font = "600 18px/1 system-ui, sans-serif";
        option.action.style.opacity = "0.72";
        const label = `Install ${RENDERER_AGENT_LABELS[agent]}`;
        option.action.setAttribute("aria-label", label);
        option.action.title = label;
      }
      option.action.setAttribute("aria-hidden", String(!visible));
    }
  }
  return view;
}
