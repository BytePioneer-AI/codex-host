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
import { RpcError, type EventHub } from "./transport.ts";
import { withHarnessDisplayOrder } from "./harness-display-order.ts";
import type { WebHarnessPreferences } from "./harness-preferences.ts";

export class ChHarnessCatalog {
  private plugins: Promise<HarnessPluginDescriptor[]> | undefined;
  private inspections = new Map<string, Promise<HarnessInspection>>();
  private readonly pendingRefreshes = new Map<
    string,
    { inspection: Promise<HarnessInspection>; notified: boolean }
  >();
  private readonly refreshing = new Map<
    string | undefined,
    ReturnType<ChHarnessCatalog["readModels"]>
  >();
  private readonly stop: (() => void) | undefined;
  constructor(
    private readonly host: ChHostClient,
    events: EventHub,
    readonly displayEntries: () => Promise<HarnessDisplayEntries> = async () => [],
    readonly preferences?: WebHarnessPreferences,
    /** Optional advanced subset override from `--harness`; absent means every Host plugin. */
    private readonly restrictTo?: ReadonlySet<string>,
  ) {
    this.stop = host.realtime?.subscribe((event) => {
      if (event.type === "harness-inspection-changed") {
        // The Host can announce a local refresh before returning its result.
        const refresh = this.pendingRefreshes.get(event.harnessId);
        this.invalidate(
          event.harnessId,
          refresh?.notified === false ? refresh.inspection : undefined,
        );
        if (refresh) refresh.notified = true;
        events.emit("codexhost/harness-inspection-changed");
      } else if (event.type === "hello") {
        this.inspections.clear();
        this.pendingRefreshes.clear();
        this.plugins = undefined;
        this.refreshing.clear();
        events.emit("codexhost/harness-inspection-changed");
      }
    });
  }
  close(): void {
    this.stop?.();
  }
  async list(): Promise<HarnessPluginDescriptor[]> {
    if (this.plugins) return this.plugins;
    const plugins = this.host
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
        if (this.plugins === plugins) this.plugins = undefined;
        throw error;
      });
    this.plugins = plugins;
    return plugins;
  }
  private invalidate(id: string, preserve?: Promise<HarnessInspection>): void {
    for (const [key, inspection] of this.inspections) {
      if (inspection !== preserve && JSON.parse(key)[0] === id) this.inspections.delete(key);
    }
  }
  async inspect(id: string, cwd?: string, refresh = false): Promise<HarnessInspection> {
    const key = JSON.stringify([id, cwd]);
    if (refresh) {
      const pending = this.pendingRefreshes.get(id)?.inspection;
      if (pending && this.inspections.get(key) === pending) return pending;
      this.invalidate(id);
    }
    let inspection = this.inspections.get(key);
    if (!inspection) {
      inspection = this.host
        .request("codexhost/harness/inspect", {
          harnessId: id,
          ...(cwd ? { cwd } : {}),
          ...(refresh ? { refresh: true } : {}),
        })
        .then((value) => {
          const result = harnessInspectionSchema.parse(value);
          if (
            id === "codex" &&
            result.status !== "ready" &&
            this.inspections.get(key) === inspection
          )
            this.inspections.delete(key);
          return result;
        })
        .catch((error: unknown) => {
          if (this.inspections.get(key) === inspection) this.inspections.delete(key);
          throw error;
        });
      if (refresh) {
        inspection = inspection.finally(() => {
          if (this.pendingRefreshes.get(id)?.inspection === inspection)
            this.pendingRefreshes.delete(id);
        });
        this.pendingRefreshes.set(id, { inspection, notified: false });
      }
      this.inspections.set(key, inspection);
    }
    return inspection;
  }
  async models(refresh = false, harnessId?: string) {
    if (!refresh) {
      // A notification during a batch may invalidate one of its earlier results.
      await Promise.allSettled(this.refreshing.values());
      return this.readModels(false);
    }
    const pending = this.refreshing.get(harnessId);
    if (pending) return pending;
    const operation = this.readModels(true, harnessId).finally(() => {
      if (this.refreshing.get(harnessId) === operation) this.refreshing.delete(harnessId);
    });
    this.refreshing.set(harnessId, operation);
    return operation;
  }
  private async readModels(refresh: boolean, harnessId?: string) {
    const shouldRefresh = (id: string) => refresh && (harnessId === undefined || harnessId === id);
    const plugins = await this.list();
    const values = await Promise.all(
      plugins.map(async ({ id, name }) => ({
        id,
        name,
        inspection: await this.inspect(id, undefined, shouldRefresh(id)),
      })),
    );
    if (this.restrictTo === undefined || this.restrictTo.has("codex")) {
      const inspection = await this.inspect("codex", undefined, shouldRefresh("codex")).catch(
        () => undefined,
      );
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
