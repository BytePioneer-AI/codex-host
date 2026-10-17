/**
 * Harness registry backed by codexhost Adapter plugins.
 *
 * Plugins are loaded exactly like the codexhost Host loads them: read `manifest.json`, import its
 * `entry`, and call `createHarnessAdapter(context)`. Each Harness then appears to the Web UI as
 * one model-provider group whose models and reasoning efforts come from `inspect()`.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { HarnessPluginContext, HarnessPluginModule } from "@codexhost/harness-adapter/plugin";
import {
  HARNESS_PLUGIN_API_VERSION,
  harnessPluginManifestSchema,
  isHarnessPluginInScope,
  type HarnessPluginScope,
  type HarnessPluginManifest,
  type HarnessDisplayEntries,
} from "@codexhost/shared-contracts";
import { pluginResourcePath } from "@codexhost/harness-plugin-files";
import { withHarnessDisplayOrder } from "./harness-display-order.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";

export type HarnessManifest = Pick<
  HarnessPluginManifest,
  "id" | "name" | "entry" | "icon" | "iconStyle" | "kind"
>;

import type { Adapter, Inspection } from "@codexhost/session-runtime";
export type {
  Adapter,
  Inspection,
  HarnessSessionLike,
  PermissionModeCatalog,
} from "@codexhost/session-runtime";

interface HarnessEntry {
  manifest: HarnessManifest;
  dir: string;
  adapter?: Promise<Adapter> | undefined;
  inspection?: Inspection;
  inspectedAt?: number;
}

export interface ModelGroup {
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    description?: string;
    reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string };
  }>;
}

const INSPECTION_TTL_MS = 5 * 60_000;

export class HarnessRegistry {
  private readonly entries = new Map<string, HarnessEntry>();

  /**
   * @param adapterRoots - directories containing one Adapter plugin per child directory.
   * @param enabled - optional allow-list of Harness ids.
   */
  constructor(
    adapterRoots: readonly string[],
    enabled?: ReadonlySet<string>,
    private readonly options: {
      scope?: HarnessPluginScope;
      environment?: NodeJS.ProcessEnv;
      displayEntries?: () => Promise<HarnessDisplayEntries>;
      preferences?: () => WebHarnessPreferences | undefined;
    } = {},
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
        // Codex execution is opt-in even when its files are in a shared bundle.
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
  get preferences(): WebHarnessPreferences | undefined {
    return this.options.preferences?.();
  }

  manifest(harnessId: string): HarnessManifest | undefined {
    return this.entries.get(harnessId)?.manifest;
  }

  iconPath(harnessId: string): string | undefined {
    const entry = this.entries.get(harnessId);
    return entry?.manifest.icon === undefined ? undefined : join(entry.dir, entry.manifest.icon);
  }

  adapter(harnessId: string): Promise<Adapter> {
    const entry = this.entries.get(harnessId);
    if (entry === undefined) return Promise.reject(new Error(`Unknown Harness ${harnessId}`));
    entry.adapter ??= (async () => {
      const module = (await import(
        pathToFileURL(await pluginResourcePath(entry.dir, entry.manifest.entry)).href
      )) as HarnessPluginModule;
      const context: HarnessPluginContext = {
        environment: Object.freeze({ ...(this.options.environment ?? process.env) }),
        platform: process.platform,
        managedRemoteHost: false,
      };
      const adapter = await module.createHarnessAdapter(context);
      if (
        adapter.harnessId !== harnessId ||
        typeof adapter.open !== "function" ||
        typeof adapter.inspect !== "function" ||
        typeof adapter.close !== "function"
      ) {
        await adapter.close?.();
        throw new Error(`Invalid Harness plugin: ${harnessId}`);
      }
      return adapter as Adapter;
    })();
    entry.adapter.catch(() => {
      entry.adapter = undefined;
    });
    return entry.adapter;
  }

  async inspect(harnessId: string, refresh = false): Promise<Inspection> {
    const entry = this.entries.get(harnessId);
    if (entry === undefined)
      return { status: "error", error: { message: `Unknown Harness ${harnessId}` } };
    if (
      !refresh &&
      entry.inspection !== undefined &&
      Date.now() - (entry.inspectedAt ?? 0) < INSPECTION_TTL_MS
    ) {
      return entry.inspection;
    }
    try {
      const adapter = await this.adapter(harnessId);
      const inspection = await withTimeout(
        adapter.inspect({ refresh }),
        30_000,
        `${harnessId} inspection timed out`,
      );
      entry.inspection = inspection;
      entry.inspectedAt = Date.now();
      return inspection;
    } catch (error) {
      const inspection: Inspection = {
        status: "error",
        error: { message: error instanceof Error ? error.message : String(error) },
      };
      entry.inspection = inspection;
      entry.inspectedAt = Date.now();
      return inspection;
    }
  }

  /** User's last explicit model choice; becomes the catalog default while it stays available. */
  preferredSelection: { provider: string; model: string; reasoningEffort?: string } | undefined;

  /** DSH `session/modelCatalog` value: one provider group per ready Harness. */
  async modelCatalog(): Promise<{
    default: { provider: string; model: string };
    routableProviders: string[];
    groups: ModelGroup[];
    failures: Array<{ id: string; name: string; message: string }>;
    harnessOrder?: string[];
    modelFavorites?: Record<string, string[]>;
    preferencesAvailable?: boolean;
  }> {
    const ids = this.ids();
    const inspections = await Promise.all(
      ids.map(async (id) => [id, await this.inspect(id)] as const),
    );
    const groups: ModelGroup[] = [];
    const failures: Array<{ id: string; name: string; message: string }> = [];
    for (const [id, inspection] of inspections) {
      const name = this.manifest(id)?.name ?? id;
      if (inspection.status !== "ready") {
        // A Harness that is simply not installed is not a failure worth showing in the picker.
        if (
          inspection.status === "notInstalled" ||
          /not installed/iu.test(inspection.error.message)
        )
          continue;
        const firstLine =
          inspection.error.message.split("\n").find((line) => line.trim() !== "") ??
          inspection.error.message;
        failures.push({
          id,
          name,
          message: firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine,
        });
        continue;
      }
      groups.push(groupOf(id, name, inspection));
    }
    const first = groups.find((group) => group.models.length > 0);
    const firstInspection = inspections.find(([id]) => id === first?.id)?.[1];
    const defaultModel =
      firstInspection?.status === "ready"
        ? (firstInspection.catalog.defaultModel?.id ?? first?.models[0]?.id)
        : undefined;
    const preferred = this.preferredSelection;
    const displayEntries = (await this.options.displayEntries?.()) ?? [];
    if (
      preferred !== undefined &&
      groups.some(
        (group) =>
          group.id === preferred.provider &&
          group.models.some((model) => model.id === preferred.model),
      )
    ) {
      const catalog = withHarnessDisplayOrder(
        {
          default: preferred,
          routableProviders: groups.map((group) => group.id),
          groups,
          failures,
        },
        displayEntries,
      );
      return this.preferences ? this.preferences.decorate(catalog) : catalog;
    }
    const catalog = withHarnessDisplayOrder(
      {
        default: { provider: first?.id ?? "none", model: defaultModel ?? "none" },
        routableProviders: groups.map((group) => group.id),
        groups,
        failures,
      },
      displayEntries,
    );
    return this.preferences ? this.preferences.decorate(catalog) : catalog;
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.adapter === undefined) return;
        try {
          await (await entry.adapter).close();
        } catch {
          // Closing is best effort at shutdown.
        }
      }),
    );
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

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
