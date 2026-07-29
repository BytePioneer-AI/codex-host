import { installRendererBindingProbe } from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

window.__codexhostRendererBindingProbeV1?.dispose();
const probe = installRendererBindingProbe();
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
    asset: null,
    reason: "bridge-unavailable",
    decoratedRequests: 0,
    modelUpdates: 0,
    candidateCount: 0,
    candidates: [],
    hook: null,
  });
}
