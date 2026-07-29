import { DEFAULT_RENDERER_AGENTS } from "./agent-selection-state.js";
import { installRendererBindingProbe } from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

declare global {
  interface Window {
    __codexhostRendererConfigurationV1?: {
      enableClaudeCode?: boolean;
    };
  }
}

window.__codexhostRendererBindingProbeV1?.dispose();
const enabledAgents = window.__codexhostRendererConfigurationV1?.enableClaudeCode
  ? [...DEFAULT_RENDERER_AGENTS, "claude-code" as const]
  : DEFAULT_RENDERER_AGENTS;
const probe = installRendererBindingProbe({ enabledAgents });
try {
  const adapter = installCurrentRendererAdapter();
  probe.setAdapter(
    adapter.status,
    adapter.dispose,
    adapter.applyAgent,
    adapter.applyPiModel,
    adapter.modelControl,
  );
} catch (error) {
  console.error(
    "codexhost Renderer Adapter installation failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  probe.setAdapter({
    state: "unsupported",
    reason: "bridge-unavailable",
    decoratedRequests: 0,
    modelUpdates: 0,
    candidateCount: 0,
    candidates: [],
    hook: null,
  });
}
