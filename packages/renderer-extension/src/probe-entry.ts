import { installRendererBindingProbe } from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

window.__codexhostRendererBindingProbeV1?.dispose();
const probe = installRendererBindingProbe();
void installCurrentRendererAdapter(() => probe.lockedSelection()).then((adapter) => {
  probe.setAdapter(adapter.status, adapter.dispose);
});
