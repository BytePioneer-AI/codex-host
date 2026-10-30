import {
  catalogModelForRef,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";
import {
  ensureRendererTriggerChipStyle,
  TRIGGER_CHIP_CLASS,
} from "./renderer-trigger-chip-style.js";
import { mountRendererModelFastTooltip } from "./renderer-model-fast-tooltip.js";

export interface RendererModelFastControl {
  button: HTMLButtonElement;
  render(
    catalog: HarnessModelCatalog | undefined,
    selected: HarnessModelRef | undefined,
    disabled: boolean,
    zh: boolean,
  ): void;
  close(): void;
  dispose(): void;
}

/** A sibling of the Model trigger, never a nested button or another Model menu entry. */
export function mountRendererModelFastControl(
  document: Document,
  onSelect: (modelId: string) => void,
): RendererModelFastControl {
  ensureRendererTriggerChipStyle(document);
  const button = document.createElement("button");
  button.type = "button";
  button.className = TRIGGER_CHIP_CLASS;
  button.dataset.codexhostFastToggle = "true";
  button.setAttribute("aria-label", "Fast");
  button.hidden = true;
  button.style.cssText =
    "width:24px;height:28px;flex:none;padding:3px;border-radius:6px;display:none";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.style.flexShrink = "0";
  icon.setAttribute("aria-hidden", "true");
  const bolt = document.createElementNS("http://www.w3.org/2000/svg", "path");
  // Codex Desktop 26.928.20755 ModelPickerTriggerInlineModeIcon: 24-unit
  // filled path rendered at 14px. Keep the geometry local, not its private UI classes.
  bolt.setAttribute(
    "d",
    "M11.9125 21.4125C11.5292 21.8625 11.0292 22.0958 10.4125 22.1125C9.79586 22.1291 9.29586 21.9208 8.91252 21.4875C8.53752 21.0541 8.45836 20.4541 8.67503 19.6875L9.68752 16H4.57502C4.00836 16 3.56669 15.8375 3.25002 15.5125C2.93336 15.1791 2.77502 14.7791 2.77502 14.3125C2.77502 13.8375 2.92919 13.4125 3.23752 13.0375L12.1375 2.47497C12.5209 2.02497 13.0209 1.79164 13.6375 1.77497C14.2542 1.75831 14.75 1.96664 15.125 2.39997C15.5084 2.83331 15.5917 3.43331 15.375 4.19997L14.3125 7.99998H19.425C19.9917 7.99998 20.4334 8.16664 20.75 8.49997C21.075 8.83331 21.2375 9.23748 21.2375 9.71247C21.2375 10.1791 21.0792 10.5958 20.7625 10.9625L11.9125 21.4125Z",
  );
  bolt.setAttribute("stroke-width", "1.6");
  bolt.setAttribute("stroke-linejoin", "round");
  icon.append(bolt);
  button.append(icon);
  const tooltip = mountRendererModelFastTooltip(button);
  let next: HarnessModelRef | undefined;
  const click = (event: MouseEvent): void => {
    event.stopPropagation();
    if (next && !button.disabled) onSelect(next.id);
  };
  button.addEventListener("click", click);
  return {
    button,
    render(catalog, selected, disabled, zh) {
      const model = catalogModelForRef(catalog, selected);
      const available = model?.fastModel !== undefined;
      const enabled = available && model?.fastModel?.id === selected?.id;
      next = available ? (enabled ? model?.ref : model?.fastModel) : undefined;
      button.hidden = !available;
      button.style.display = available ? "inline-flex" : "none";
      button.disabled = disabled;
      button.style.color = enabled ? "inherit" : "var(--color-text-tertiary, #8f8f8f)";
      bolt.setAttribute("fill", enabled ? "currentColor" : "none");
      // Only the Host's off state is outlined; a stroke would thicken the native fill.
      bolt.setAttribute("stroke", enabled ? "none" : "currentColor");
      button.setAttribute("aria-pressed", String(enabled));
      tooltip.render(
        zh
          ? `Fast 已${enabled ? "开启 · 点击关闭" : "关闭 · 点击开启"}\nCodex Fast 模式：优先处理请求，可能增加额度消耗。`
          : `Fast is ${enabled ? "on · Click to disable" : "off · Click to enable"}\nCodex Fast mode prioritizes requests and may increase usage.`,
      );
    },
    close: tooltip.close,
    dispose() {
      tooltip.dispose();
      button.removeEventListener("click", click);
      button.remove();
    },
  };
}
