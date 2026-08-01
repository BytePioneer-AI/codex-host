import { DEFAULT_RENDERER_AGENTS } from "./agent-selection-state.js";
import { installRendererBinding } from "./install-renderer-binding.js";

declare global {
  interface Window {
    __codexhostRendererConfigurationV1?: {
      enableClaudeCode?: boolean;
    };
  }
}

const enabledAgents = window.__codexhostRendererConfigurationV1?.enableClaudeCode
  ? [...DEFAULT_RENDERER_AGENTS, "claude-code" as const]
  : DEFAULT_RENDERER_AGENTS;
installRendererBinding(enabledAgents);
