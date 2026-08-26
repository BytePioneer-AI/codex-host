import type {
  ComposerAgentPhase,
  ExternalRendererAgent,
  RendererAgent,
  RendererAgentAvailability,
} from "./agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

export const RENDERER_AGENT_INSTALL_URLS: Readonly<Record<ExternalRendererAgent, string>> = {
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/docs/en/quickstart",
  "deepseek-harness": "https://github.com/deepseek-ai/deepseek-harness",
  grok: "https://grok.com/",
};

type AgentAvailability = Partial<Record<ExternalRendererAgent, RendererAgentAvailability>>;

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";
const AGENT_MENU_WIDTH = 200;

interface AgentOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
  download: HTMLButtonElement | null;
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
  return {
    label: RENDERER_AGENT_LABELS[state.agent],
    triggerDisabled: switching || state.phase === "locked" || agents.length < 2,
    nativeModelHidden: switching || state.agent !== "codex",
    optionDisabled,
    downloadVisible,
  };
}

function setMenuPosition(control: RendererAgentPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const width = AGENT_MENU_WIDTH;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  control.menu.style.left = `${left}px`;
  control.menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
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

  const close = (): void => {
    if (!popoverOpen(menu)) return;
    if (typeof menu.hidePopover === "function") menu.hidePopover();
    else menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const focusOption = (position: "first" | "last" | "selected"): void => {
    const available = enabledAgents
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

    const download =
      agent === "codex"
        ? null
        : (() => {
            const control = document.createElement("button");
            control.type = "button";
            control.textContent = "+";
            control.setAttribute("aria-label", `Install ${RENDERER_AGENT_LABELS[agent]}`);
            control.title = `Install ${RENDERER_AGENT_LABELS[agent]}`;
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
            control.style.color = "inherit";
            control.style.cursor = "pointer";
            control.style.font = "600 18px/1 system-ui, sans-serif";
            control.style.opacity = "0.72";
            control.addEventListener("pointerenter", () => {
              if (!control.disabled) control.style.background = "rgba(127, 127, 127, 0.16)";
            });
            control.addEventListener("pointerleave", () => {
              control.style.background = "transparent";
            });
            control.addEventListener("click", (event) => {
              event.stopPropagation();
              onDownload(agent);
            });
            return control;
          })();
    options[agent] = { button, check, download };
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
    if (download) actionSlot.append(download);
    row.append(actionSlot, button);
    menu.append(row);
  }
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
    const buttons = enabledAgents
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
    if (option.download) {
      const visible = view.downloadVisible[agent as ExternalRendererAgent] === true;
      option.download.hidden = false;
      option.download.disabled = !visible;
      option.download.setAttribute("aria-hidden", String(!visible));
      option.download.style.display = "inline-flex";
      option.download.style.visibility = visible ? "visible" : "hidden";
      option.download.style.pointerEvents = visible ? "auto" : "none";
    }
  }
  return view;
}
