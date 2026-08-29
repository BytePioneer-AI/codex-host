import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RENDERER_PROBE_AGENTS, validateProbeStatus } from "../../tools/renderer-binding/run.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function source(relative) {
  return readFile(path.join(root, relative), "utf8");
}

describe("production Renderer release chain", () => {
  it("uses the fixed production Agent list without a development enable switch", async () => {
    const [productionEntry, probeEntry, installer, agentState] = await Promise.all([
      source("packages/renderer-extension/src/production-entry.ts"),
      source("packages/renderer-extension/src/probe-entry.ts"),
      source("packages/renderer-extension/src/install-renderer-binding.ts"),
      source("packages/renderer-extension/src/agent-selection-state.ts"),
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
  });

  it("accepts Grok in renderer probe capabilities and selections", () => {
    const status = validateProbeStatus({
      version: 2,
      mountedComposers: 1,
      enabledAgents: [...RENDERER_PROBE_AGENTS],
      selections: [{ composerId: "composer-grok", agent: "grok", phase: "draft" }],
      adapter: { state: "ready", reason: "ready", modelUpdates: 0 },
    });

    expect(RENDERER_PROBE_AGENTS).toContain("grok");
    expect(status.selections).toEqual([
      { composerId: "composer-grok", agent: "grok", phase: "draft" },
    ]);
    expect(() =>
      validateProbeStatus({
        ...status,
        selections: [{ composerId: "composer-unknown", agent: "unknown", phase: "draft" }],
      }),
    ).toThrow("invalid selection");
  });

  it("builds the local audit entry without packaging it in production", async () => {
    const [rendererManifest, auditEntry, releaseBuilder] = await Promise.all([
      source("packages/renderer-extension/package.json"),
      source("packages/renderer-extension/src/audit-entry.ts"),
      source("scripts/release/prepare-payload.mjs"),
    ]);

    expect(rendererManifest).toContain("src/audit-entry.ts");
    expect(rendererManifest).toContain("dist/contract-audit.js");
    expect(auditEntry).toContain("__codexhostContractAuditV1");
    expect(releaseBuilder).not.toContain("contract-audit.js");
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
