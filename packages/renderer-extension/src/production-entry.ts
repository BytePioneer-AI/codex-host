import { DEFAULT_RENDERER_AGENTS, type RendererAgent } from "./agent-selection-state.js";
import { installRendererBinding } from "./install-renderer-binding.js";

declare global {
  interface Window {
    __codexhostProductionConfigV1?: {
      defaultAgent: RendererAgent;
    };
  }
}

const configuration = window.__codexhostProductionConfigV1;
delete window.__codexhostProductionConfigV1;

const install = (): void => {
  installRendererBinding(DEFAULT_RENDERER_AGENTS, configuration?.defaultAgent ?? "codex");
};

if (document.documentElement && document.body) {
  install();
} else {
  window.addEventListener("DOMContentLoaded", install, { once: true });
}
