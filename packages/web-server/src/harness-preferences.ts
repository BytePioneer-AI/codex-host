/** Web preferences use the shared owner RPC. */
import {
  DEFAULT_IDLE_RELEASE_SETTINGS,
  HARNESS_PREFERENCES_GET_METHOD,
  HARNESS_PREFERENCES_PATCH_METHOD,
  harnessPreferenceSnapshotSchema,
  harnessPreferenceOperationSchema,
  installedHarnessPluginIdSchema,
  type HarnessPreferenceOperation,
  type HarnessPreferenceSnapshot,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import { type EventHub, type RpcRegistry } from "./transport.ts";
import type { ModelGroup } from "./harnesses.ts";

export class WebHarnessPreferences {
  private unsubscribe: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(
    private readonly host: ChHostClient,
    private readonly events: EventHub,
  ) {
    if (host.realtime)
      this.unsubscribe = host.realtime.subscribe((event) => {
        if (event.type === "preferences-changed" || event.type === "hello")
          events.emit("codexhost/preferences-changed");
      });
    if (!host.realtime) {
      let revision = -1;
      let busy = false;
      this.pollTimer = setInterval(() => {
        if (busy) return;
        busy = true;
        void this.get()
          .then((snapshot) => {
            if (!this.closed && snapshot.revision !== revision) {
              revision = snapshot.revision;
              events.emit("codexhost/preferences-changed");
            }
          })
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, 3000);
      this.pollTimer.unref();
    }
  }
  async get(): Promise<HarnessPreferenceSnapshot> {
    return harnessPreferenceSnapshotSchema.parse(
      await this.host.request(HARNESS_PREFERENCES_GET_METHOD, { scope: "external" }),
    );
  }
  private async patch(operations: HarnessPreferenceOperation[], initializeOnly = false) {
    const input = { scope: "external", operations, initializeOnly };
    const result = harnessPreferenceSnapshotSchema.parse(
      await this.host.request(HARNESS_PREFERENCES_PATCH_METHOD, input),
    );
    this.events.emit("codexhost/preferences-changed");
    return result;
  }
  async configuration(harnessId: string) {
    return (await this.get()).values.newThread?.byHarness[harnessId];
  }
  async remember(
    harnessId: string,
    configuration: {
      model?: { id: string };
      thinkingOptionId?: string | undefined;
      permissionModeId?: string | undefined;
    },
  ) {
    const id = installedHarnessPluginIdSchema.parse(harnessId);
    const operation = harnessPreferenceOperationSchema.parse({
      kind: "newThread",
      harnessId: id,
      configuration,
    });
    await this.patch([operation]);
    await this.patch([{ kind: "newThread", lastHarness: id }]);
  }
  async decorate<
    T extends {
      default: { provider: string; model: string; reasoningEffort?: string };
      groups: ModelGroup[];
    },
  >(catalog: T) {
    try {
      const external = await this.get();
      const favorites = external.values.favorites;
      const configurationFor = (harnessId: string) =>
        external.values.newThread?.byHarness[harnessId];
      const preferred =
        catalog.groups.find((group) => group.id === external.values.newThread?.lastHarness) ??
        catalog.groups.find((group) => group.id === catalog.default.provider);
      const selectionFor = (
        group: ModelGroup,
        fallbackModelId?: string,
      ): { provider: string; model: string; reasoningEffort?: string } | undefined => {
        const configuration = configurationFor(group.id);
        const model =
          // A remembered Fast ref restores its base Model: new Threads start with Fast off.
          group.models.find(
            (model) =>
              model.id === configuration?.model?.id || model.fastModel === configuration?.model?.id,
          ) ??
          group.models.find((model) => model.id === fallbackModelId) ??
          group.models[0];
        if (!model) return undefined;
        const effort = model.reasoning?.efforts.some(
          (option) => option.id === configuration?.thinkingOptionId,
        )
          ? configuration?.thinkingOptionId
          : model.reasoning?.defaultEffort;
        return {
          provider: group.id,
          model: model.id,
          ...(effort ? { reasoningEffort: effort } : {}),
        };
      };
      const rememberedSelections = Object.fromEntries(
        catalog.groups.flatMap((group) => {
          if (!configurationFor(group.id)?.model) return [];
          const selection = selectionFor(group);
          return selection ? ([[group.id, selection]] as const) : [];
        }),
      );
      const defaultSelection = preferred
        ? selectionFor(
            preferred,
            preferred.id === catalog.default.provider ? catalog.default.model : undefined,
          )
        : undefined;
      return {
        ...catalog,
        default: defaultSelection ?? catalog.default,
        rememberedSelections,
        modelFavorites: favorites,
        preferencesAvailable: true,
      };
    } catch {
      // An older Host may lack preference RPCs; ordinary Sessions stay usable.
      return {
        ...catalog,
        rememberedSelections: {},
        modelFavorites: {},
        preferencesAvailable: false,
      };
    }
  }
  register(rpc: RpcRegistry) {
    rpc.register("codexhost/preferences/get", async () => {
      const external = await this.get();
      return {
        idleRelease: external.values.idleRelease ?? DEFAULT_IDLE_RELEASE_SETTINGS,
        idleReleaseAvailable: true,
        revision: external.revision,
      };
    });
    rpc.register("codexhost/preferences/patch", async (args) => {
      const operation = harnessPreferenceOperationSchema.parse(args.operation);
      return this.patch([operation]);
    });
    rpc.register("codexhost/preferences/migrate", async (args) => {
      const favorites = Array.isArray(args.favorites)
        ? (args.favorites as Array<{ provider: string; modelIds: string[] }>)
        : [];
      for (const entry of favorites) {
        const operation = harnessPreferenceOperationSchema.parse({
          kind: "favorites",
          harnessId: entry.provider,
          modelIds: entry.modelIds,
        });
        await this.patch([operation], true);
      }
      return {};
    });
  }
  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribe?.();
  }
}
