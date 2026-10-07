import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import codexAgentIconUrl from "./assets/codex-agent.png";

export function rendererAgentLabel(agent: string, plugin?: HarnessPluginDescriptor): string {
  return agent === "codex" ? "Codex" : (plugin?.name ?? agent);
}

function createSvgIcon(
  paths: readonly { d: string; fillRule?: string | undefined; fill?: string | undefined }[],
  color: string,
  size: number,
  ownerDocument: Document,
  viewBox = "0 0 24 24",
): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  svg.style.flex = "none";
  svg.style.fill = color;
  for (const definition of paths) {
    const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", definition.d);
    if (definition.fillRule) path.setAttribute("fill-rule", definition.fillRule);
    if (definition.fill) path.setAttribute("fill", definition.fill);
    svg.append(path);
  }
  return svg;
}

/** Older Hosts can omit styling. Reuse it only for the identical plugin and image bytes. */
export function compatibleRendererPluginPresentation(
  plugin: HarnessPluginDescriptor | undefined,
  reference: HarnessPluginDescriptor | undefined,
): HarnessPluginDescriptor | undefined {
  return plugin &&
    !plugin.iconStyle &&
    plugin.icon &&
    reference?.id === plugin.id &&
    reference.icon === plugin.icon &&
    reference.iconStyle
    ? { ...plugin, iconStyle: reference.iconStyle }
    : plugin;
}

/** Construct only validated path primitives; never inject plugin SVG markup or UI code. */
export function createRendererAgentIcon(
  agent: string,
  size = 20,
  ownerDocument: Document = document,
  plugin?: HarnessPluginDescriptor,
): Element {
  const source = agent === "codex" ? codexAgentIconUrl : plugin?.icon;
  const presentation = agent === "codex" ? undefined : plugin?.iconStyle;
  if (presentation?.vector) {
    const { paths, color, viewBox } = presentation.vector;
    return createSvgIcon(paths, color, size, ownerDocument, viewBox);
  }
  if (source) {
    const image = ownerDocument.createElement("img");
    image.src = source;
    image.alt = "";
    image.draggable = false;
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
    image.style.objectFit = "contain";
    image.style.flex = "none";
    if (presentation?.borderRadius !== undefined)
      image.style.borderRadius = `${presentation.borderRadius}%`;
    if (presentation?.background) image.style.background = presentation.background;
    if (presentation?.paddingRatio) {
      image.style.boxSizing = "border-box";
      image.style.padding = `${Math.max(1, Math.round(size * presentation.paddingRatio))}px`;
    }
    return image;
  }
  const fallback = ownerDocument.createElement("span");
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = rendererAgentLabel(agent, plugin).slice(0, 1).toUpperCase();
  fallback.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex:none;font-size:${Math.round(size * 0.7)}px`;
  return fallback;
}
