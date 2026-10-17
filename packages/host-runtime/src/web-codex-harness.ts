import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessPluginModule } from "@codexhost/harness-adapter/plugin";
import { pluginResourcePath } from "@codexhost/harness-plugin-files";
import {
  HARNESS_PLUGIN_API_VERSION,
  harnessPluginManifestSchema,
  isHarnessPluginInScope,
  harnessPreferenceSnapshotSchema,
  type WebCodexConfiguration,
} from "@codexhost/shared-contracts";
import type { Adapter, Inspection, SessionHarnesses } from "@codexhost/session-runtime";

/** A single explicitly selected plugin, cold until inspect/open. No external registry changes. */
export async function createWebCodexHarness(
  config: WebCodexConfiguration,
  environment: NodeJS.ProcessEnv,
  scope: string,
  preferencesRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const candidates = [];
  for (const root of config.pluginRoots) {
    const directory = path.join(root, "codex");
    try {
      const manifest = harnessPluginManifestSchema.parse(
        JSON.parse(await readFile(await pluginResourcePath(directory, "manifest.json"), "utf8")),
      );
      if (
        manifest.id !== "codex" ||
        !isHarnessPluginInScope(manifest.id, "web-codex") ||
        manifest.kind === "usage" ||
        manifest.adapterApiVersion !== HARNESS_PLUGIN_API_VERSION
      )
        throw new Error("Invalid isolated Codex plugin manifest");
      candidates.push({ directory: await realpath(directory), manifest });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (candidates.length !== 1)
    throw new Error("Select exactly one installed isolated Codex plugin");
  const candidate = candidates[0];
  if (!candidate) throw new Error("Isolated Codex plugin missing");
  const module = (await import(
    pathToFileURL(await pluginResourcePath(candidate.directory, candidate.manifest.entry)).href
  )) as HarnessPluginModule;
  const native = await module.createHarnessAdapter({
    environment: Object.freeze({
      ...environment,
      CODEXHOST_CODEX_HOME: config.home,
      CODEXHOST_CODEX_COMMAND: config.command,
    }),
    platform: process.platform,
    managedRemoteHost: false,
  });
  if (native.harnessId !== "codex") {
    await native.close();
    throw new Error("Isolated Codex plugin identity mismatch");
  }
  const adapter = native as unknown as Adapter;
  const preference = async (method: string, params: Record<string, unknown>) =>
    harnessPreferenceSnapshotSchema.parse(await preferencesRequest(method, params));
  let inspection: Inspection | undefined;
  const harnesses: SessionHarnesses = {
    ids: () => ["codex"],
    manifest: (id) => (id === "codex" ? candidate.manifest : undefined),
    adapter: async (id) => {
      if (id !== "codex") throw new Error("Harness is outside the isolated source");
      return adapter;
    },
    inspect: async (id) => {
      if (id !== "codex") throw new Error("Harness is outside the isolated source");
      return (inspection ??= await adapter.inspect());
    },
    preferredSelection: undefined,
    preferences: {
      configuration: async (id) => {
        if (id !== "codex") throw new Error("Harness is outside the isolated source");
        return (await preference("codexhost/harness/preferences/get", { scope })).values.newThread
          ?.byHarness.codex;
      },
      remember: async (id, configuration) => {
        if (id !== "codex") throw new Error("Harness is outside the isolated source");
        await preference("codexhost/harness/preferences/patch", {
          scope,
          operations: [{ kind: "newThread", harnessId: "codex", configuration }],
        });
      },
    },
    modelCatalog: async () => {
      const value = await harnesses.inspect("codex");
      if (value.status !== "ready")
        return {
          default: { provider: "none", model: "none" },
          groups: [],
          routableProviders: [],
          failures: [{ id: "codex", name: candidate.manifest.name, message: value.error.message }],
        };
      const options = new Map(
        value.catalog.thinkingOptions.map((option) => [option.id, option.label]),
      );
      const models = value.catalog.models.map((model) => {
        const supported = model.supportedThinkingOptionIds ?? [...options.keys()];
        const efforts = supported.map((id) => ({ id, name: options.get(id) ?? id }));
        return {
          id: model.ref.id,
          name: model.label,
          ...(efforts.length
            ? {
                reasoning: {
                  efforts,
                  ...(value.catalog.defaultThinkingOptionId
                    ? { defaultEffort: value.catalog.defaultThinkingOptionId }
                    : {}),
                },
              }
            : {}),
        };
      });
      const remembered = await harnesses.preferences?.configuration("codex");
      const preferred = harnesses.preferredSelection;
      const selected = preferred?.model ?? remembered?.model?.id ?? value.catalog.defaultModel?.id;
      const model = models.find((model) => model.id === selected) ?? models[0];
      const effort = preferred?.reasoningEffort ?? remembered?.thinkingOptionId;
      return {
        default: {
          provider: "codex",
          model: model?.id ?? "none",
          ...(effort ? { reasoningEffort: effort } : {}),
        },
        groups: [{ id: "codex", name: candidate.manifest.name, models }],
        routableProviders: ["codex"],
        failures: [],
      };
    },
  };
  return {
    harnesses,
    manifest: candidate.manifest,
    close: async () => {
      await adapter.close();
    },
  };
}
