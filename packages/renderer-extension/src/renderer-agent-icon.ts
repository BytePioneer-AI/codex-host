import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import codexAgentIconUrl from "./assets/codex-agent.png";

export function rendererAgentLabel(agent: string, plugin?: HarnessPluginDescriptor): string {
  return agent === "codex" ? "Codex" : (plugin?.name ?? agent);
}

/** Plugin images are validated Host data. Never inline their SVG or execute plugin UI code. */
export function createRendererAgentIcon(
  agent: string,
  size = 20,
  ownerDocument: Document = document,
  plugin?: HarnessPluginDescriptor,
): Element {
  const source = agent === "codex" ? codexAgentIconUrl : plugin?.icon;
  if (source) {
    const image = ownerDocument.createElement("img");
    image.src = source;
    image.alt = "";
    image.draggable = false;
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
    image.style.objectFit = "contain";
    image.style.flex = "none";
    return image;
  }
  const fallback = ownerDocument.createElement("span");
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = rendererAgentLabel(agent, plugin).slice(0, 1).toUpperCase();
  fallback.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;flex:none;font-size:${Math.round(size * 0.7)}px`;
  return fallback;
}
