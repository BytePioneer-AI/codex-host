/** Harness metadata for the Web gateway; execution and inspection belong to Host. */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HARNESS_PLUGIN_API_VERSION,
  harnessPluginManifestSchema,
  isHarnessPluginInScope,
  type HarnessPluginScope,
  type HarnessPluginManifest,
} from "@codexhost/shared-contracts";
import type { Inspection } from "@codexhost/session-runtime";
export type { Inspection } from "@codexhost/session-runtime";

export type HarnessManifest = Pick<
  HarnessPluginManifest,
  "id" | "name" | "entry" | "icon" | "iconStyle" | "kind"
>;

export interface ModelGroup {
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    description?: string;
    /** Native Fast variant of this Model; selected through the same Model RPC. */
    fastModel?: string;
    reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string };
  }>;
}

export interface HarnessCatalog {
  ids(): string[];
  manifest(id: string): HarnessManifest | undefined;
  iconPath(id: string): string | undefined;
  inspect(id: string): Promise<Inspection>;
  modelCatalog(): Promise<{
    default: { provider: string; model: string };
    routableProviders: string[];
    groups: ModelGroup[];
    failures: Array<{ id: string; name: string; message: string }>;
    harnessOrder?: string[];
    rememberedSelections?: Record<
      string,
      { provider: string; model: string; reasoningEffort?: string }
    >;
    modelFavorites?: Record<string, string[]>;
    preferencesAvailable?: boolean;
  }>;
  close(): Promise<void>;
}

export class HarnessRegistry {
  private readonly entries = new Map<string, { manifest: HarnessManifest; dir: string }>();

  constructor(
    adapterRoots: readonly string[],
    enabled?: ReadonlySet<string>,
    options: { scope?: HarnessPluginScope } = {},
  ) {
    for (const root of adapterRoots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root).sort()) {
        const dir = realpathSync(resolve(root, name));
        const manifestPath = join(dir, "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = harnessPluginManifestSchema.parse(
          JSON.parse(readFileSync(manifestPath, "utf8")),
        );
        if (manifest.kind === "usage") continue;
        if (!isHarnessPluginInScope(manifest.id, options.scope ?? "external")) continue;
        if (manifest.id === "codex" && !enabled?.has("codex")) continue;
        if (enabled !== undefined && !enabled.has(manifest.id)) continue;
        if (manifest.adapterApiVersion !== HARNESS_PLUGIN_API_VERSION)
          throw new Error(`Incompatible Harness plugin API: ${manifest.id}`);
        if (!existsSync(join(dir, manifest.entry))) continue;
        if (this.entries.has(manifest.id))
          throw new Error(`Duplicate Harness plugin: ${manifest.id}`);
        this.entries.set(manifest.id, { manifest, dir });
      }
    }
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  manifest(harnessId: string): HarnessManifest | undefined {
    return this.entries.get(harnessId)?.manifest;
  }

  iconPath(harnessId: string): string | undefined {
    const entry = this.entries.get(harnessId);
    return entry?.manifest.icon === undefined ? undefined : join(entry.dir, entry.manifest.icon);
  }
}

export function groupOf(
  id: string,
  name: string,
  inspection: Extract<Inspection, { status: "ready" }>,
): ModelGroup {
  const { catalog } = inspection;
  const options = new Map(catalog.thinkingOptions.map((option) => [option.id, option]));
  return {
    id,
    name,
    models: catalog.models.map((model) => {
      const supported =
        model.supportedThinkingOptionIds ?? catalog.thinkingOptions.map((option) => option.id);
      const efforts = supported.flatMap((optionId) => {
        const option = options.get(optionId);
        return option === undefined ? [] : [{ id: option.id, name: option.label }];
      });
      return {
        id: model.ref.id,
        name: model.label,
        ...(model.resolvedModelLabel !== undefined && model.resolvedModelLabel !== model.label
          ? { description: model.resolvedModelLabel }
          : {}),
        ...(model.fastModel ? { fastModel: model.fastModel.id } : {}),
        ...(efforts.length > 0
          ? {
              reasoning: {
                efforts,
                ...(catalog.defaultThinkingOptionId !== undefined &&
                supported.includes(catalog.defaultThinkingOptionId)
                  ? { defaultEffort: catalog.defaultThinkingOptionId }
                  : {}),
              },
            }
          : {}),
      };
    }),
  };
}
