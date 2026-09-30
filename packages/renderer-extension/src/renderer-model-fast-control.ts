import {
  catalogModelForRef,
  type HarnessModelCatalog,
  type HarnessModelRef,
} from "@codexhost/shared-contracts";

export interface RendererModelFastControl {
  button: HTMLButtonElement;
  render(
    catalog: HarnessModelCatalog | undefined,
    selected: HarnessModelRef | undefined,
    disabled: boolean,
    zh: boolean,
  ): void;
  dispose(): void;
}

/** A sibling of the Model trigger, never a nested button or another Model menu entry. */
export function mountRendererModelFastControl(
  document: Document,
  onSelect: (modelId: string) => void,
): RendererModelFastControl {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.codexhostFastToggle = "true";
  button.hidden = true;
  button.style.cssText =
    "width:24px;height:28px;flex:none;padding:3px;border:0;border-radius:6px;background:transparent;cursor:pointer;display:none;align-items:center;justify-content:center";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("aria-hidden", "true");
  const bolt = document.createElementNS("http://www.w3.org/2000/svg", "path");
  bolt.setAttribute("d", "m13 2-9 12h7l-1 8 10-13h-7l1-7Z");
  bolt.setAttribute("stroke", "currentColor");
  bolt.setAttribute("stroke-width", "1.6");
  bolt.setAttribute("stroke-linejoin", "round");
  icon.append(bolt);
  button.append(icon);
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
      button.style.opacity = disabled ? "0.4" : "1";
      button.style.color = enabled
        ? "var(--color-icon-accent, #f59e0b)"
        : "var(--color-text-tertiary, #8f8f8f)";
      bolt.setAttribute("fill", enabled ? "currentColor" : "none");
      button.setAttribute("aria-pressed", String(enabled));
      button.title = zh
        ? enabled
          ? "关闭 Fast"
          : "开启 Fast：优先处理，可能增加额度消耗"
        : enabled
          ? "Disable Fast"
          : "Enable Fast: priority processing may increase usage";
      button.setAttribute("aria-label", button.title);
    },
    dispose() {
      button.removeEventListener("click", click);
      button.remove();
    },
  };
}
