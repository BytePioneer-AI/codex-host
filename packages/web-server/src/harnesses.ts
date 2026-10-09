/**
 * Harness registry backed by codexhost Adapter plugins.
 *
 * Plugins are loaded exactly like the codexhost Host loads them: read `manifest.json`, import its
 * `entry`, and call `createHarnessAdapter(context)`. Each Harness then appears to the Web UI as
 * one model-provider group whose models and reasoning efforts come from `inspect()`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { HarnessPluginContext, HarnessPluginModule } from "@codexhost/harness-adapter/plugin";
import type { HarnessCommandCatalog, HarnessPluginManifest } from "@codexhost/shared-contracts";

export type HarnessManifest = Pick<
  HarnessPluginManifest,
  "id" | "name" | "entry" | "icon" | "kind"
>;

interface ModelRef {
  id: string;
}

interface CatalogModel {
  ref: ModelRef;
  label: string;
  resolvedModelLabel?: string;
  supportedThinkingOptionIds?: string[];
}

interface ModelCatalog {
  models: CatalogModel[];
  defaultModel?: ModelRef;
  thinkingOptions: Array<{ id: string; label: string }>;
  defaultThinkingOptionId?: string;
}

export interface PermissionModeCatalog {
  modes: Array<{ id: string; label: string; description?: string; dangerous?: boolean }>;
  defaultModeId: string;
}

export type Inspection =
  | {
      status: "ready";
      catalog: ModelCatalog;
      permissionModes?: PermissionModeCatalog;
      capabilities: {
        configuration: {
          selectModel: boolean;
          selectThinkingOption: boolean;
          selectPermissionMode: boolean;
          permissionModeScope?: "live" | "atCreate";
        };
        history: { fork: boolean; forkAcrossCwd: boolean; rollbackLastTurn: boolean };
      };
    }
  | { status: "notInstalled" | "unavailable" | "error"; error: { code?: string; message: string } };

/** Structural subset of the codexhost HarnessAdapter used by the server. */
export interface Adapter {
  readonly harnessId: string;
  readonly commandCatalog?: HarnessCommandCatalog;
  inspect(input?: { cwd?: string; refresh?: boolean }): Promise<Inspection>;
  open(
    input: Record<string, unknown> & { kind: string; cwd: string },
  ): Promise<
    | { ok: true; value: HarnessSessionLike }
    | { ok: false; error: { code: string; message: string } }
  >;
  close(): Promise<void>;
}

export interface HarnessSessionLike {
  readonly harnessId: string;
  readonly capabilities: {
    configuration?: { selectPermissionMode: boolean; permissionModeScope?: "live" | "atCreate" };
    steering?: { native?: boolean };
  };
  readonly initialState: {
    nativeRef?: unknown;
    effectiveModel?: ModelRef;
    effectiveThinkingOptionId?: string;
    effectivePermissionModeId?: string;
    resolvedModelLabel?: string;
  };
  readonly initialUsage: unknown;
  readonly outputs: AsyncIterable<
    | { kind: "event"; event: Record<string, unknown> & { type: string } }
    | { kind: "interaction"; interaction: Record<string, unknown> & { type: string } }
  >;
  readonly commands?: {
    list(): Promise<unknown>;
    execute(command: {
      turnId: string;
      commandId: string;
      arguments?: unknown;
    }): Promise<{ ok: boolean; error?: { message: string } }>;
  };
  hasBackgroundWork?(): boolean;
  readSnapshot(): Promise<
    | { ok: true; value: { turns: unknown[]; state?: unknown } }
    | { ok: false; error: { code: string; message: string } }
  >;
  execute(
    command: Record<string, unknown>,
  ): Promise<
    { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
  >;
  close(): Promise<void>;
}

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
  constructor(adapterRoots: readonly string[], enabled?: ReadonlySet<string>) {
    for (const root of adapterRoots) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root).sort()) {
        const dir = resolve(root, name);
        const manifestPath = join(dir, "manifest.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as HarnessManifest;
        if (manifest.kind === "usage") continue;
        if (enabled !== undefined && !enabled.has(manifest.id)) continue;
        if (!existsSync(join(dir, manifest.entry))) continue;
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

  adapter(harnessId: string): Promise<Adapter> {
    const entry = this.entries.get(harnessId);
    if (entry === undefined) return Promise.reject(new Error(`Unknown Harness ${harnessId}`));
    entry.adapter ??= (async () => {
      const module = (await import(
        pathToFileURL(join(entry.dir, entry.manifest.entry)).href
      )) as HarnessPluginModule;
      const context: HarnessPluginContext = {
        environment: { ...process.env },
        platform: process.platform,
        managedRemoteHost: false,
      };
      return (await module.createHarnessAdapter(context)) as Adapter;
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
    if (
      preferred !== undefined &&
      groups.some(
        (group) =>
          group.id === preferred.provider &&
          group.models.some((model) => model.id === preferred.model),
      )
    ) {
      return {
        default: preferred,
        routableProviders: groups.map((group) => group.id),
        groups,
        failures,
      };
    }
    return {
      default: { provider: first?.id ?? "none", model: defaultModel ?? "none" },
      routableProviders: groups.map((group) => group.id),
      groups,
      failures,
    };
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

function groupOf(
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
