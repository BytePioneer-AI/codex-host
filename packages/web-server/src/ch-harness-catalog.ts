/** Native plugin/model metadata from the same Host as the shared Threads, never local Adapter instances. */
import {
  harnessInspectionSchema,
  harnessPluginListResultSchema,
  type HarnessPluginDescriptor,
  type HarnessInspection,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { groupOf, type Inspection } from "./harnesses.ts";
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
import { RpcError } from "./transport.ts";

export class ChHarnessCatalog {
  private plugins?: HarnessPluginDescriptor[];
  private inspections = new Map<string, Promise<HarnessInspection>>();
  constructor(private readonly host: ChHostClient) {}
  async list(): Promise<HarnessPluginDescriptor[]> {
    this.plugins ??= harnessPluginListResultSchema
      .parse(await this.host.request("codexhost/harness/plugins/list", {}))
      .plugins.filter((plugin) => plugin.kind !== "usage");
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
        .then((value) => harnessInspectionSchema.parse(value))
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
      plugins.map(async (plugin) => ({ plugin, inspection: await this.inspect(plugin.id) })),
    );
    const groups = values.flatMap(({ plugin, inspection }) =>
      inspection.status === "ready"
        ? [groupOf(plugin.id, plugin.name, inspection as Inspection & { status: "ready" })]
        : [],
    );
    const first = values.find(
      (value) => value.inspection.status === "ready" && value.inspection.catalog.models.length,
    );
    if (!first || first.inspection.status !== "ready")
      throw new RpcError("host/no-harness", "CH has no ready session Harness.");
    const selection: ModelSelection = {
      provider: first.plugin.id,
      model:
        first.inspection.catalog.defaultModel?.id ??
        first.inspection.catalog.models[0]?.ref.id ??
        "",
    };
    return {
      default: selection,
      groups,
      routableProviders: groups.map((group) => group.id),
      failures: values.flatMap(({ plugin, inspection }) =>
        inspection.status !== "ready" && inspection.status !== "notInstalled"
          ? [{ id: plugin.id, name: plugin.name, message: inspection.error.message }]
          : [],
      ),
    };
  }
  async name(id: string): Promise<string> {
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
