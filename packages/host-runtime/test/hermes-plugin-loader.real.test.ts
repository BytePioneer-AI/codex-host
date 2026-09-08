import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { harnessIdSchema } from "@codexhost/shared-contracts";

import { loadHarnessPlugins, type HarnessPluginDiagnostic } from "../src/harness-plugin-loader.js";

/**
 * Real-loader acceptance for the Hermes harness plugin:
 * a temp isolated plugin root (never the user's ~/.codexhost), the real
 * packaged entry, and a real `hermes acp` child process. Follows the
 * "development acceptance uses temporary isolated roots" rule.
 * This stays read-only because Hermes ACP does not expose Session deletion.
 */
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const pluginSource = path.join(repoRoot, "packages/host-runtime/dist/plugins/hermes");

let root: string | undefined;
const diagnostics: HarnessPluginDiagnostic[] = [];

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function installHermesPlugin(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), "hermes-plugin-root-"));
  await writeFile(
    path.join(root, "enabled.json"),
    JSON.stringify({ version: 1, enabled: ["hermes"] }),
  );
  await cp(pluginSource, path.join(root, "hermes"), { recursive: true });
  return root;
}

// Local acceptance only: standard CI intentionally has no Hermes installation
// or user credentials. Run explicitly with CODEXHOST_RUN_HERMES_LIVE=1.
describe.skipIf(process.env.CODEXHOST_RUN_HERMES_LIVE !== "1")(
  "Hermes harness plugin (real loader + real hermes acp)",
  () => {
    it(
      "loads through loadHarnessPlugins and reports the real read-only inventory",
      { timeout: 60_000 },
      async () => {
        const pluginRoot = await installHermesPlugin();
        const registry = await loadHarnessPlugins({
          roots: [pluginRoot],
          context: {
            environment: process.env,
            platform: process.platform,
            managedRemoteHost: false,
          },
          diagnose: (diagnostic) => diagnostics.push(diagnostic),
        });
        const descriptor = registry.list().find(({ id }) => id === "hermes");
        expect(descriptor).toBeDefined();
        expect(descriptor?.id).toBe("hermes");

        const adapter = registry.adapters.get(harnessIdSchema.parse("hermes"));
        expect(adapter).toBeDefined();
        if (!adapter) throw new Error("Expected Hermes Adapter");
        expect(adapter.harnessId).toBe("hermes");

        // Inspect is honest: catalog and default come from Hermes' real picker
        // inventory without creating a persisted native Session.
        const inspection = await adapter.inspect({ cwd: repoRoot, refresh: true });
        expect(inspection.status).toBe("ready");
        if (inspection.status !== "ready") throw new Error("unreachable");
        expect(inspection.catalog.models.length).toBeGreaterThan(0);
        expect(inspection.catalog.models.every(({ label }) => label.includes(" / "))).toBe(true);
        expect(inspection.permissionModes?.modes.map((mode) => mode.id)).toEqual([
          "default",
          "accept_edits",
          "dont_ask",
        ]);

        await registry.close();
        expect(diagnostics).toEqual([]);
      },
    );
  },
);
