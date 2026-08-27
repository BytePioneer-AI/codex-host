import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

describe("production Renderer release chain", () => {
  it("uses the fixed production Agent list without a development enable switch", async () => {
    const [productionEntry, probeEntry, installer, agentState, rendererBindingTool] =
      await Promise.all([
        source("packages/renderer-extension/src/production-entry.ts"),
        source("packages/renderer-extension/src/probe-entry.ts"),
        source("packages/renderer-extension/src/install-renderer-binding.ts"),
        source("packages/renderer-extension/src/agent-selection-state.ts"),
        source("tools/renderer-binding/run.mjs"),
      ]);

    expect(agentState).toContain('"deepseek-harness",');
    expect(agentState).toContain('"grok",');
    expect(agentState).toContain("DEFAULT_RENDERER_AGENTS = KNOWN_RENDERER_AGENTS");
    expect(productionEntry).toContain("installRendererBinding(DEFAULT_RENDERER_AGENTS");
    expect(productionEntry).toContain("__codexhostProductionConfigV1");
    expect(productionEntry).not.toContain("RendererConfiguration");
    expect(probeEntry).toContain("installRendererBinding(DEFAULT_RENDERER_AGENTS)");
    expect(probeEntry).not.toContain("enableClaudeCode");
    expect(installer).toContain("installCurrentRendererAdapter");
    expect(rendererBindingTool).toContain('"grok",');
    expect(rendererBindingTool).toContain("RENDERER_PROBE_AGENTS.includes(agent)");
    expect(rendererBindingTool).toContain("enabledAgents = [...RENDERER_PROBE_AGENTS]");
  });

  it("builds and packages executable production entries", async () => {
    const [rendererManifest, releaseBuilder] = await Promise.all([
      source("packages/renderer-extension/package.json"),
      source("scripts/release/prepare-payload.mjs"),
    ]);

    expect(rendererManifest).toContain("src/production-entry.ts");
    expect(rendererManifest).toContain("dist/production.js");
    expect(releaseBuilder).toContain('dist", "production.js');
    expect(releaseBuilder).toContain("desktop-controller.mjs");
    expect(releaseBuilder).toContain('packageName: "lucide"');
    expect(releaseBuilder).toContain("lucide-LICENSE.txt");
    expect(releaseBuilder).not.toContain('dist", "index.js"');
  });

  it("requires Launcher consumption rather than file presence alone", async () => {
    const [layout, launcher] = await Promise.all([
      source("crates/launcher/src/installation_layout.rs"),
      source("crates/launcher/src/main.rs"),
    ]);

    expect(layout).toContain("desktop_controller");
    expect(layout).toContain("renderer_extension");
    expect(launcher).toContain("--inspector-endpoint");
    expect(launcher).toContain("desktop_controller");
    expect(launcher).toContain("renderer_extension");
  });
});
