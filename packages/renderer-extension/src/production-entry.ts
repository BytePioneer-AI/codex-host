import { DEFAULT_RENDERER_AGENTS } from "./agent-selection-state.js";
import { installRendererBinding } from "./install-renderer-binding.js";

const install = (): void => {
  installRendererBinding(DEFAULT_RENDERER_AGENTS);
};

if (document.documentElement && document.body) {
  install();
} else {
  window.addEventListener("DOMContentLoaded", install, { once: true });
}
