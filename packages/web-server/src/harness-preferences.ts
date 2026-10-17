/** Web preferences use the shared owner RPC; standalone keeps an independent file. */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { HarnessPreferencesStore } from "@codexhost/harness-plugin-files";
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
import type { DataDir } from "./store.ts";
import { type EventHub, type RpcRegistry, RpcError } from "./transport.ts";
import type { ModelGroup } from "./harnesses.ts";

function canonicalHome(value: string): string {
  const path = resolve(value);
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(canonicalHome(parent), basename(path));
}
export class WebHarnessPreferences {
  private readonly store: HarnessPreferencesStore | undefined;
  private readonly codexScope: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private get localStore() {
    if (!this.store) throw new Error("Preferences are owned by CH");
    return this.store;
  }
  constructor(
    private readonly host: ChHostClient | undefined,
    data: DataDir,
    private readonly events: EventHub,
    codexHome?: string,
  ) {
    if (!host) this.store = new HarnessPreferencesStore(data.root);
    if (codexHome)
      this.codexScope = `web-codex:${createHash("sha256").update(canonicalHome(codexHome)).digest("hex")}`;
    if (host?.realtime)
      this.unsubscribe = host.realtime.subscribe((event) => {
        if (event.type === "preferences-changed" || event.type === "hello")
          events.emit("codexhost/preferences-changed");
      });
    else if (this.store)
      void this.store
        .subscribe(() => events.emit("codexhost/preferences-changed"))
        .then((remove) => {
          if (this.closed) remove();
          else this.unsubscribe = remove;
        })
        .catch(() =>
          events.emit(
            "codexhost/preferences-error",
            "Preference change monitoring is unavailable.",
          ),
        );
    if (host && !host.realtime) {
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
  private scope(harnessId?: string) {
    if (harnessId !== "codex") return "external";
    if (!this.codexScope)
      throw new RpcError("preferences/unavailable", "Web Codex preferences are unavailable.");
    return this.codexScope;
  }
  async get(harnessId?: string): Promise<HarnessPreferenceSnapshot> {
    const scope = this.scope(harnessId);
    return this.host
      ? harnessPreferenceSnapshotSchema.parse(
          await this.host.request(HARNESS_PREFERENCES_GET_METHOD, { scope }),
        )
      : this.localStore.get(scope);
  }
  private async patch(
    harnessId: string | undefined,
    operations: HarnessPreferenceOperation[],
    initializeOnly = false,
  ) {
    const input = { scope: this.scope(harnessId), operations, initializeOnly };
    const result = this.host
      ? harnessPreferenceSnapshotSchema.parse(
          await this.host.request(HARNESS_PREFERENCES_PATCH_METHOD, input),
        )
      : await this.localStore.patch(input);
    this.events.emit("codexhost/preferences-changed");
    return result;
  }
  async configuration(harnessId: string) {
    return (await this.get(harnessId)).values.newThread?.byHarness[harnessId];
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
    await this.patch(harnessId, [operation]);
    await this.patch(undefined, [{ kind: "newThread", lastHarness: id }]);
  }
  async decorate<
    T extends {
      default: { provider: string; model: string; reasoningEffort?: string };
      groups: ModelGroup[];
    },
  >(catalog: T) {
    try {
      const external = await this.get();
      const code = this.codexScope ? await this.get("codex") : undefined;
      const favorites = {
        ...external.values.favorites,
        ...(code ? { codex: code.values.favorites.codex ?? [] } : {}),
      };
      const preferred =
        catalog.groups.find((group) => group.id === external.values.newThread?.lastHarness) ??
        catalog.groups.find((group) => group.id === catalog.default.provider);
      const configuration =
        preferred?.id === "codex"
          ? code?.values.newThread?.byHarness.codex
          : preferred
            ? external.values.newThread?.byHarness[preferred.id]
            : undefined;
      const model =
        preferred?.models.find((model) => model.id === configuration?.model?.id) ??
        preferred?.models.find((model) => model.id === catalog.default.model) ??
        preferred?.models[0];
      const effort = model?.reasoning?.efforts.some(
        (option) => option.id === configuration?.thinkingOptionId,
      )
        ? configuration?.thinkingOptionId
        : model?.reasoning?.defaultEffort;
      return {
        ...catalog,
        default:
          preferred && model
            ? {
                provider: preferred.id,
                model: model.id,
                ...(effort ? { reasoningEffort: effort } : {}),
              }
            : catalog.default,
        modelFavorites: favorites,
        preferencesAvailable: true,
      };
    } catch {
      // An older Host may lack preference RPCs; ordinary Sessions stay usable.
      return { ...catalog, modelFavorites: {}, preferencesAvailable: false };
    }
  }
  async initialize(legacySelection?: {
    provider: string;
    model: string;
    reasoningEffort?: string;
  }) {
    if (legacySelection) {
      if (legacySelection.provider !== "codex" || this.codexScope) {
        const operation = harnessPreferenceOperationSchema.parse({
          kind: "newThread",
          harnessId: legacySelection.provider,
          configuration: {
            model: { id: legacySelection.model },
            thinkingOptionId: legacySelection.reasoningEffort,
          },
        });
        await this.patch(legacySelection.provider, [operation], true);
        await this.patch(
          undefined,
          [
            {
              kind: "newThread",
              lastHarness: installedHarnessPluginIdSchema.parse(legacySelection.provider),
            },
          ],
          true,
        );
      }
    }
  }
  register(rpc: RpcRegistry) {
    rpc.register("codexhost/preferences/get", async () => {
      const external = await this.get();
      return {
        idleRelease: external.values.idleRelease ?? DEFAULT_IDLE_RELEASE_SETTINGS,
        idleReleaseAvailable: Boolean(this.host),
        revision: external.revision,
      };
    });
    rpc.register("codexhost/preferences/patch", async (args) => {
      const operation = harnessPreferenceOperationSchema.parse(args.operation);
      if (operation.kind === "idleRelease" && !this.host)
        throw new RpcError(
          "preferences/unavailable",
          "Idle release settings require the shared Host.",
        );
      const harnessId = "harnessId" in operation ? operation.harnessId : undefined;
      return this.patch(harnessId, [operation]);
    });
    rpc.register("codexhost/preferences/migrate", async (args) => {
      const favorites = Array.isArray(args.favorites)
        ? (args.favorites as Array<{ provider: string; modelIds: string[] }>)
        : [];
      for (const entry of favorites) {
        if (entry.provider === "codex" && !this.codexScope) continue;
        const operation = harnessPreferenceOperationSchema.parse({
          kind: "favorites",
          harnessId: entry.provider,
          modelIds: entry.modelIds,
        });
        await this.patch(entry.provider, [operation], true);
      }
      return {};
    });
  }
  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribe?.();
    await this.store?.close();
  }
}
