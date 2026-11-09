/** Native plugin/model metadata from the same Host as the shared Threads, never local Adapter instances. */
import {
  harnessInspectionSchema,
  harnessIdSchema,
  harnessPluginListResultSchema,
  type HarnessPluginDescriptor,
  type HarnessInspection,
  type HarnessDisplayEntries,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { groupOf, type Inspection } from "./harnesses.ts";
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
import { RpcError } from "./transport.ts";
import { withHarnessDisplayOrder } from "./harness-display-order.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";

export class ChHarnessCatalog {
  private plugins: Promise<HarnessPluginDescriptor[]> | undefined;
  private inspections = new Map<string, Promise<HarnessInspection>>();
  constructor(
    private readonly host: ChHostClient,
    readonly displayEntries: () => Promise<HarnessDisplayEntries> = async () => [],
    readonly preferences?: WebHarnessPreferences,
    /** Optional advanced subset override from `--harness`; absent means every Host plugin. */
    private readonly restrictTo?: ReadonlySet<string>,
  ) {}
  async list(): Promise<HarnessPluginDescriptor[]> {
    this.plugins ??= this.host
      .request("codexhost/harness/plugins/list", {})
      .then((value) =>
        harnessPluginListResultSchema
          .parse(value)
          .plugins.filter(
            (plugin) =>
              plugin.kind !== "usage" &&
              (this.restrictTo === undefined || this.restrictTo.has(plugin.id)),
          ),
      )
      .catch((error: unknown) => {
        this.plugins = undefined;
        throw error;
      });
    return this.plugins;
  }
  async inspect(id: string, cwd?: string): Promise<HarnessInspection> {
    const key = JSON.stringify([id, cwd]);
    let inspection = this.inspections.get(key);
    if (!inspection) {
      inspection = this.host
        .request("codexhost/harness/inspect", {
          harnessId: id,
          ...(cwd ? { cwd } : {}),
        })
        .then((value) => {
          const result = harnessInspectionSchema.parse(value);
          if (id === "codex" && result.status !== "ready") this.inspections.delete(key);
          return result;
        })
        .catch((error: unknown) => {
          this.inspections.delete(key);
          throw error;
        });
      this.inspections.set(key, inspection);
    }
    return inspection;
  }
  async models() {
    const plugins = await this.list();
    const values = await Promise.all(
      plugins.map(async (plugin) => ({
        id: plugin.id,
        name: plugin.name,
        inspection: await this.inspect(plugin.id),
      })),
    );
    if (this.restrictTo === undefined || this.restrictTo.has("codex")) {
      const inspection = await this.inspect("codex").catch(() => undefined);
      if (inspection)
        values.unshift({ id: harnessIdSchema.parse("codex"), name: "Codex", inspection });
    }
    const groups = values.flatMap(({ id, name, inspection }) =>
      inspection.status === "ready"
        ? [groupOf(id, name, inspection as Inspection & { status: "ready" })]
        : [],
    );
    const first = values.find(
      (value) => value.inspection.status === "ready" && value.inspection.catalog.models.length,
    );
    if (!first || first.inspection.status !== "ready")
      throw new RpcError("host/no-harness", "CH has no ready session Harness.");
    const selection: ModelSelection = {
      provider: first.id,
      model:
        first.inspection.catalog.defaultModel?.id ??
        first.inspection.catalog.models[0]?.ref.id ??
        "",
    };
    const catalog = withHarnessDisplayOrder(
      {
        default: selection,
        groups,
        routableProviders: groups.map((group) => group.id),
        failures: values.flatMap(({ id, name, inspection }) =>
          inspection.status !== "ready" && inspection.status !== "notInstalled"
            ? [{ id, name, message: inspection.error.message }]
            : [],
        ),
      },
      await this.displayEntries(),
    );
    return this.preferences ? this.preferences.decorate(catalog) : catalog;
  }
  async name(id: string): Promise<string> {
    if (id === "codex") return "Codex";
    return (await this.list()).find((plugin) => plugin.id === id)?.name ?? id;
  }
  async icon(id: string): Promise<{ body: Buffer; contentType: string } | undefined> {
    const value = (await this.list()).find((plugin) => plugin.id === id)?.icon;
    if (!value) return undefined;
    const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,(.+)$/u.exec(value);
    return match?.[1] && match[2]
      ? { body: Buffer.from(match[2], "base64"), contentType: match[1] }
      : undefined;
  }
}
