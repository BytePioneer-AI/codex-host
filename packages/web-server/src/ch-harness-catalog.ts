/** Native plugin/model metadata from the same Host as the shared Threads, never local Adapter instances. */
import {
  harnessInspectionSchema,
  harnessModelRefKey,
  harnessIdSchema,
  harnessPluginListResultSchema,
  type HarnessPluginDescriptor,
  type HarnessInspection,
  type HarnessDisplayEntries,
  type HarnessPreferenceSnapshot,
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
  private lastPlugins: HarnessPluginDescriptor[] | undefined;
  private pluginsEpoch: string | undefined;
  private lastHelloEpoch: string | undefined;
  private pluginsGeneration = 0;
  private pluginsResolvedGeneration = -1;
  private inspections = new Map<string, Promise<HarnessInspection>>();
  private readonly pendingRefreshes = new Map<
    string,
    { inspection: Promise<HarnessInspection>; notified: boolean; retryCredentials: boolean }
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
    private readonly currentEpoch?: () => string | undefined,
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
        const epoch = event.cursor.epoch;
        // Preserve in-flight or resolved plugin catalog when the initial hello matches the
        // epoch already probed from manifest, or on a non-reset same-epoch stream resume.
        const sameInitialEpoch =
          this.lastHelloEpoch === undefined &&
          this.pluginsEpoch !== undefined &&
          this.pluginsEpoch === epoch;
        const sameResumeEpoch = !event.reset && this.lastHelloEpoch === epoch;
        this.lastHelloEpoch = epoch;
        if (!sameInitialEpoch && !sameResumeEpoch) {
          this.pluginsGeneration += 1;
          this.plugins = undefined;
          this.pluginsEpoch = undefined;
        }
        this.inspections.clear();
        this.pendingRefreshes.clear();
        this.refreshing.clear();
        events.emit("codexhost/harness-inspection-changed");
      }
    });
  }
  close(): void {
    this.stop?.();
  }
  hasFreshList(): boolean {
    return this.plugins !== undefined;
  }
  hasResolvedCurrentList(): boolean {
    return this.pluginsResolvedGeneration === this.pluginsGeneration;
  }
  currentGeneration(): number {
    return this.pluginsGeneration;
  }
  async list(): Promise<HarnessPluginDescriptor[]> {
    if (this.plugins) return this.plugins;
    const generation = this.pluginsGeneration;
    this.pluginsEpoch = this.currentEpoch?.() ?? this.lastHelloEpoch;
    const plugins = this.host
      .request("codexhost/harness/plugins/list", {})
      .then((value) => {
        const filtered = harnessPluginListResultSchema
          .parse(value)
          .plugins.filter(
            (plugin) =>
              plugin.kind !== "usage" &&
              (this.restrictTo === undefined || this.restrictTo.has(plugin.id)),
          );
        if (generation === this.pluginsGeneration) {
          this.lastPlugins = filtered;
          this.pluginsResolvedGeneration = generation;
        }
        return filtered;
      })
      .catch((error: unknown) => {
        if (this.plugins === plugins) {
          this.plugins = undefined;
          this.pluginsEpoch = undefined;
        }
        throw error;
      });
    this.plugins = plugins;
    return plugins;
  }
  cachedList(): HarnessPluginDescriptor[] | undefined {
    return this.lastPlugins;
  }
  private invalidate(id: string, preserve?: Promise<HarnessInspection>): void {
    for (const [key, inspection] of this.inspections) {
      if (inspection !== preserve && JSON.parse(key)[0] === id) this.inspections.delete(key);
    }
  }
  async inspect(
    id: string,
    cwd?: string,
    refresh: boolean | "re-detect" = false,
  ): Promise<HarnessInspection> {
    const key = JSON.stringify([id, cwd]);
    const retryCredentials = refresh === "re-detect";
    if (refresh) {
      const pending = this.pendingRefreshes.get(id);
      if (pending && this.inspections.get(key) === pending.inspection) {
        if (!retryCredentials || pending.retryCredentials) return pending.inspection;
        await Promise.allSettled([pending.inspection]);
        return this.inspect(id, cwd, refresh);
      }
      this.invalidate(id);
    }
    let inspection = this.inspections.get(key);
    if (!inspection) {
      const params = {
        harnessId: id,
        ...(cwd ? { cwd } : {}),
        ...(refresh ? { refresh: true } : {}),
      };
      const request = retryCredentials
        ? this.host
            .request("codexhost/harness/inspect", { ...params, credentialAccess: "retry" })
            .catch((error: unknown) => {
              // A preview can reuse an older shared Host. Retry only a rejected parameter, not an uncertain result.
              if (!(
                error instanceof RpcError &&
                error.code === "host/rejected" &&
                (error.details as { hostCode?: unknown }).hostCode === -32602
              ))
                throw error;
              return this.host.request("codexhost/harness/inspect", params);
            })
        : this.host.request("codexhost/harness/inspect", params);
      inspection = request
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
        this.pendingRefreshes.set(id, { inspection, notified: false, retryCredentials });
      }
      this.inspections.set(key, inspection);
    }
    return inspection;
  }
  async models(
    refresh = false,
    harnessId?: string,
    preferences?: Promise<HarnessPreferenceSnapshot | undefined>,
  ) {
    if (!refresh) {
      // A notification during a batch may invalidate one of its earlier results.
      await Promise.allSettled(this.refreshing.values());
      return this.readModels(false, undefined, preferences);
    }
    const pending = this.refreshing.get(harnessId);
    if (pending) return pending;
    const operation = this.readModels(true, harnessId).finally(() => {
      if (this.refreshing.get(harnessId) === operation) this.refreshing.delete(harnessId);
    });
    this.refreshing.set(harnessId, operation);
    return operation;
  }
  private async readModels(
    refresh: boolean,
    harnessId?: string,
    preferences?: Promise<HarnessPreferenceSnapshot | undefined>,
  ) {
    const shouldRefresh = (id: string) => refresh && (harnessId === undefined || harnessId === id);
    const plugins = await this.list();
    const values = await Promise.all(
      plugins.map(async ({ id, name }) => ({
        id,
        name,
        inspection: await this.inspect(
          id,
          undefined,
          refresh && id === harnessId ? "re-detect" : shouldRefresh(id),
        ),
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
    const failures = values.flatMap(({ id, name, inspection }) =>
      inspection.status !== "ready" && inspection.status !== "notInstalled"
        ? [
            {
              id,
              name,
              message: inspection.error.message,
              ...(inspection.error.code === "credentialAccessRequired"
                ? { credentialAccessRequired: true as const }
                : {}),
            },
          ]
        : [],
    );
    let selection: ModelSelection | undefined;
    if (first?.inspection.status === "ready") {
      const { defaultModel, models } = first.inspection.catalog;
      const ref = defaultModel ?? models[0]?.ref;
      if (ref) selection = { provider: first.id, model: harnessModelRefKey(ref) };
    }
    // Keep the targeted authorization action reachable even with no routable Harness.
    if (!selection && !failures.some((failure) => failure.credentialAccessRequired))
      throw new RpcError("host/no-harness", "CH has no ready session Harness.");
    const catalog = withHarnessDisplayOrder(
      {
        ...(selection ? { default: selection } : {}),
        groups,
        routableProviders: groups.map((group) => group.id),
        failures,
      },
      await this.displayEntries(),
    );
    return this.preferences && selection
      ? this.preferences.decorate({ ...catalog, default: selection }, preferences)
      : catalog;
  }
  async name(id: string): Promise<string> {
    if (id === "codex") return "Codex";
    return (await this.list()).find((plugin) => plugin.id === id)?.name ?? id;
  }
  async icon(id: string): Promise<{ body: Buffer; contentType: string } | undefined> {
    const value = (await this.list()).find((plugin) => plugin.id === id)?.icon;
    return parsePluginIconDataUrl(value);
  }
  cachedIcon(id: string): { body: Buffer; contentType: string } | undefined {
    const value = this.lastPlugins?.find((plugin) => plugin.id === id)?.icon;
    return parsePluginIconDataUrl(value);
  }
}

function parsePluginIconDataUrl(
  value: string | undefined,
): { body: Buffer; contentType: string } | undefined {
  if (!value) return undefined;
  const match = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,(.+)$/u.exec(value);
  return match?.[1] && match[2]
    ? { body: Buffer.from(match[2], "base64"), contentType: match[1] }
    : undefined;
}
