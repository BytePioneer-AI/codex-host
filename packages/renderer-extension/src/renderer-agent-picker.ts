import codexAgentIconUrl from "./assets/codex-agent.png";
import type { ComposerAgentPhase, RendererAgent } from "./agent-selection-state.js";
import type { RendererAdapterStatus } from "./versioned-renderer-adapter.js";

export const CONTROL_ATTRIBUTE = "data-codexhost-agent-control";

const AGENT_LABELS: Record<RendererAgent, string> = {
  codex: "Codex",
  pi: "Pi",
  "claude-code": "Claude Code",
};

const PI_PATHS = [
  {
    d: "M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z",
    fillRule: "evenodd",
  },
  { d: "M17.5 12H23v11h-5.5V12z" },
] as const;

const CLAUDE_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

interface AgentOptionControl {
  button: HTMLButtonElement;
  check: HTMLElement;
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
}

export function rendererAgentPickerView(
  state: { agent: RendererAgent; phase: ComposerAgentPhase },
  adapterState: RendererAdapterStatus["state"],
  switching: boolean,
  agents: readonly RendererAgent[],
): RendererAgentPickerView {
  const optionDisabled = Object.fromEntries(
    agents.map((agent) => [
      agent,
      switching || state.phase === "locked" || (agent !== "codex" && adapterState !== "ready"),
    ]),
  ) as Partial<Record<RendererAgent, boolean>>;
  return {
    label: AGENT_LABELS[state.agent],
    triggerDisabled: switching || state.phase === "locked" || agents.length < 2,
    nativeModelHidden: switching || state.agent !== "codex",
    optionDisabled,
  };
}

function createSvgIcon(
  paths: readonly { d: string; fillRule?: string }[],
  color: string,
): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = "20px";
  svg.style.height = "20px";
  svg.style.flex = "none";
  svg.style.fill = color;
  for (const definition of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", definition.d);
    if (definition.fillRule) path.setAttribute("fill-rule", definition.fillRule);
    svg.append(path);
  }
  return svg;
}

function createAgentIcon(agent: RendererAgent): Element {
  if (agent === "codex") {
    const image = document.createElement("img");
    image.src = codexAgentIconUrl;
    image.alt = "";
    image.draggable = false;
    image.style.width = "20px";
    image.style.height = "20px";
    image.style.objectFit = "contain";
    image.style.flex = "none";
    return image;
  }
  if (agent === "pi") return createSvgIcon(PI_PATHS, "currentColor");
  return createSvgIcon([{ d: CLAUDE_PATH }], "#d97757");
}

function setMenuPosition(control: RendererAgentPickerControl): void {
  const rect = control.trigger.getBoundingClientRect();
  const width = 190;
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
): RendererAgentPickerControl {
  const root = document.createElement("div");
  root.setAttribute(CONTROL_ATTRIBUTE, composerId);
  root.style.display = "inline-flex";
  root.style.alignItems = "center";
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
  trigger.style.border = "1px solid rgba(127, 127, 127, 0.28)";
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
  menu.style.width = "190px";
  menu.style.padding = "4px";
  menu.style.border = "1px solid rgba(127, 127, 127, 0.35)";
  menu.style.borderRadius = "6px";
  menu.style.background = "Canvas";
  menu.style.color = "CanvasText";
  menu.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.28)";
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
    button.style.width = "100%";
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
    check.style.width = "12px";
    check.style.flex = "none";
    check.style.visibility = "hidden";

    const label = document.createElement("span");
    label.textContent = AGENT_LABELS[agent];
    label.style.minWidth = "0";
    label.style.overflow = "hidden";
    label.style.textOverflow = "ellipsis";
    label.style.whiteSpace = "nowrap";
    button.append(check, createAgentIcon(agent), label);
    button.addEventListener("click", () => {
      const selected = button.getAttribute("aria-pressed") === "true";
      close();
      trigger.focus();
      if (!selected) onSelect(agent);
    });
    options[agent] = { button, check };
    menu.append(button);
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
): RendererAgentPickerView {
  const view = rendererAgentPickerView(state, adapterState, switching, control.agents);
  if (control.iconSlot.dataset.agent !== state.agent) {
    control.iconSlot.replaceChildren(createAgentIcon(state.agent));
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
  }
  return view;
}
