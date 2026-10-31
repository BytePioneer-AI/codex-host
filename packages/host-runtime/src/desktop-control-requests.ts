import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  HarnessPreferenceConflict,
  type HarnessLaunchSettingsStore,
  type HarnessPreferencesStore,
} from "@codexhost/harness-plugin-files";
import type { ExternalHarnessId, JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import {
  CONSOLE_OPEN_METHOD,
  CREDENTIAL_IMPORTS_METHOD,
  credentialImportsParamsSchema,
  HARNESS_DISPLAY_CAPABILITIES_METHOD,
  HARNESS_DISPLAY_GET_METHOD,
  HARNESS_DISPLAY_SET_METHOD,
  HARNESS_INSTALLATION_METHOD,
  HARNESS_INSTALLATION_START_METHOD,
  HARNESS_INSTALLATION_STATUS_METHOD,
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
  HARNESS_LAUNCH_SETTINGS_SET_METHOD,
  HARNESS_PREFERENCES_GET_METHOD,
  HARNESS_PREFERENCES_PATCH_METHOD,
  harnessAccountInspectParamsSchema,
  harnessAccountInspectResultSchema,
  harnessAccountListParamsSchema,
  harnessAccountListResultSchema,
  harnessAccountSourceListParamsSchema,
  harnessDisplayGetSchema,
  harnessDisplaySetSchema,
  harnessLaunchSettingsGetSchema,
  harnessLaunchSettingsSetSchema,
  harnessPluginListParamsSchema,
  harnessPluginListResultSchema,
  harnessPreferenceGetSchema,
  harnessPreferencePatchSchema,
  IDLE_RELEASE_SETTINGS_METHOD,
  idleReleaseSettingsSchema,
  jsonValueSchema,
  LOADED_SESSIONS_METHOD,
  USAGE_STATISTICS_METHOD,
  usageStatisticsParamsSchema,
  type HarnessAccountInspectResult,
  type HarnessPluginDescriptor,
  type HarnessPluginSurface,
  type HarnessPreferenceSnapshot,
  type LoadedSession,
} from "@codexhost/shared-contracts";

import { handleCredentialImports } from "./credential-imports.js";
import { errorMessage, rpcEnvelope, rpcError, type HostRequestOrigin } from "./desktop-rpc.js";
import { listedHarnessAccounts, listHarnessAccountSources } from "./harness-accounts.js";
import type { HarnessDisplaySettingsStore } from "./harness-display-settings.js";
import { handleHarnessInstallation, HarnessInstallationError } from "./harness-installation.js";
import { HarnessInstallationTasks } from "./harness-installation-tasks.js";
import {
  handleModelPriceOverridesRequest,
  isModelPriceOverridesMethod,
  ModelPriceOverridesError,
} from "./model-price-overrides-file.js";
import type { ModelPriceCatalog } from "./model-prices.js";
import { isSessionImportRequest } from "./session-import-requests.js";
import type { UsageStatistics } from "./usage-statistics.js";

/** The Host state and handlers that Host-level Desktop control requests act on. */
export interface DesktopControlRequestHost {
  writeJson(value: JsonValue): Promise<void>;
  /** Detaches `run` so it answers `request`, keeping the Host's failure fallback. */
  dispatchReply(request: JsonRpcRequest, run: () => Promise<void>, threadId?: string): void;
  waitForPlugins(): Promise<void>;
  diagnose(error: unknown): void;
  readonly environment: NodeJS.ProcessEnv;
  readonly preferences: HarnessPreferencesStore;
  readonly displaySettings: HarnessDisplaySettingsStore;
  readonly launchSettings: HarnessLaunchSettingsStore;
  readonly modelPrices: ModelPriceCatalog;
  readonly usageStatistics: UsageStatistics | undefined;
  readonly externalAdapters: ReadonlyMap<ExternalHarnessId, HarnessAdapter>;
  pluginDescriptors(): readonly HarnessPluginDescriptor[];
  listLoadedSessions(): LoadedSession[];
  applyHarnessPreferences(snapshot: HarnessPreferenceSnapshot): void;
  attachUsageStatistics(): void;
  eligibleFor(origin: HostRequestOrigin, surface: HarnessPluginSurface, harnessId: string): boolean;
  inspectHarnessAccount(
    adapter: HarnessAdapter,
    refresh?: boolean,
  ): Promise<HarnessAccountInspectResult>;
  handleUpdateRequest(request: JsonRpcRequest): Promise<void>;
  handleConsoleOpen(request: JsonRpcRequest): Promise<void>;
  handleCodexAccountRequest(request: JsonRpcRequest): Promise<void>;
  inspectHarness(request: JsonRpcRequest): Promise<void>;
  openHarnessWebUi(request: JsonRpcRequest): Promise<void>;
  handleSessionImport(request: JsonRpcRequest): Promise<void>;
}

/**
 * Host-level Desktop requests that are not about one Thread: Harness preferences, display and
 * launch settings, accounts, installation, plugin list, usage statistics, update and console.
 */
export class DesktopControlRequests {
  readonly #host: DesktopControlRequestHost;
  readonly #installationTasks = new HarnessInstallationTasks();

  constructor(host: DesktopControlRequestHost) {
    this.#host = host;
  }

  /** Returns false when `request` is not a control request, leaving it to Thread routing. */
  async handle(request: JsonRpcRequest, origin: HostRequestOrigin): Promise<boolean> {
    if (
      request.method === HARNESS_PREFERENCES_GET_METHOD ||
      request.method === HARNESS_PREFERENCES_PATCH_METHOD
    ) {
      try {
        const result =
          request.method === HARNESS_PREFERENCES_GET_METHOD
            ? await this.#host.preferences.get(
                harnessPreferenceGetSchema.parse(request.params ?? {}).scope,
              )
            : await this.#host.preferences.patch(
                harnessPreferencePatchSchema.parse(request.params ?? {}),
              );
        this.#host.applyHarnessPreferences(result);
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      } catch (error) {
        await this.#host.writeJson(
          rpcError(
            request,
            error instanceof HarnessPreferenceConflict ? -32091 : -32602,
            errorMessage(error),
          ),
        );
      }
      return true;
    }
    if (request.method === HARNESS_DISPLAY_CAPABILITIES_METHOD) {
      await this.#host.writeJson(
        rpcEnvelope(request, { result: { events: this.#host.displaySettings.eventsAvailable } }),
      );
      return true;
    }
    if (
      request.method === HARNESS_DISPLAY_GET_METHOD ||
      request.method === HARNESS_DISPLAY_SET_METHOD
    ) {
      const parsed = (
        request.method === HARNESS_DISPLAY_SET_METHOD
          ? harnessDisplaySetSchema
          : harnessDisplayGetSchema
      ).safeParse(request.params ?? {});
      if (!parsed.success) {
        await this.#host.writeJson(rpcError(request, -32602, "Invalid Harness display settings"));
        return true;
      }
      try {
        const store = this.#host.displaySettings;
        const result =
          request.method === HARNESS_DISPLAY_SET_METHOD
            ? await store.set(harnessDisplaySetSchema.parse(parsed.data))
            : await store.get();
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      } catch {
        await this.#host.writeJson(
          rpcError(request, -32000, "Could not save or read Harness display settings"),
        );
      }
      return true;
    }
    if (request.method === USAGE_STATISTICS_METHOD) {
      const parsed = usageStatisticsParamsSchema.safeParse(request.params ?? {});
      const statistics = this.#host.usageStatistics;
      if (!parsed.success || !statistics) {
        await this.#host.writeJson(
          parsed.success
            ? rpcError(request, -32000, "Usage statistics are unavailable on this Host")
            : rpcError(request, -32602, "Invalid usage statistics request"),
        );
        return true;
      }
      try {
        await this.#host.waitForPlugins();
        this.#host.attachUsageStatistics();
        const result = await statistics.get(parsed.data);
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      } catch (error) {
        this.#host.diagnose(error);
        await this.#host.writeJson(rpcError(request, -32000, errorMessage(error)));
      }
      return true;
    }
    if (isModelPriceOverridesMethod(request.method)) {
      try {
        const result = await handleModelPriceOverridesRequest(
          this.#host.modelPrices,
          request.method,
          request.params,
        );
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      } catch (error) {
        if (!(error instanceof ModelPriceOverridesError)) this.#host.diagnose(error);
        await this.#host.writeJson(rpcError(request, -32000, errorMessage(error)));
      }
      return true;
    }
    if (request.method === LOADED_SESSIONS_METHOD) {
      await this.#host.writeJson(rpcEnvelope(request, { result: this.#host.listLoadedSessions() }));
      return true;
    }
    if (request.method === IDLE_RELEASE_SETTINGS_METHOD) {
      const parsed = idleReleaseSettingsSchema.safeParse(request.params);
      if (!parsed.success) {
        await this.#host.writeJson(rpcError(request, -32602, "Invalid idle release settings"));
      } else {
        try {
          const saved = await this.#host.preferences.patch({
            scope: "external",
            operations: [{ kind: "idleRelease", value: parsed.data }],
          });
          this.#host.applyHarnessPreferences(saved);
          await this.#host.writeJson(rpcEnvelope(request, { result: parsed.data }));
        } catch (error) {
          await this.#host.writeJson(rpcError(request, -32000, errorMessage(error)));
        }
      }
      return true;
    }
    if (
      request.method === "codexhost/update/check" ||
      request.method === "codexhost/update/start" ||
      request.method === "codexhost/update/status"
    ) {
      this.#host.dispatchReply(request, () => this.#host.handleUpdateRequest(request));
      return true;
    }
    if (request.method === CONSOLE_OPEN_METHOD) {
      this.#host.dispatchReply(request, () => this.#host.handleConsoleOpen(request));
      return true;
    }
    if (
      request.method === "codexhost/account/usage/inspect" ||
      request.method === "codexhost/account/list" ||
      request.method === "codexhost/account/refresh"
    ) {
      this.#host.dispatchReply(request, () => this.#host.handleCodexAccountRequest(request));
      return true;
    }
    if (request.method === CREDENTIAL_IMPORTS_METHOD) {
      this.#host.dispatchReply(request, async () => {
        if (!credentialImportsParamsSchema.safeParse(request.params).success) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Invalid credential import request"),
          );
          return;
        }
        await this.#host.waitForPlugins();
        try {
          const result = await handleCredentialImports(
            request.params,
            this.#host.externalAdapters.values(),
            this.#host.environment,
          );
          await this.#host.writeJson(
            rpcEnvelope(request, { result: jsonValueSchema.parse(result) }),
          );
        } catch {
          // Credential/native SDK exceptions can include sensitive input. Never forward them.
          await this.#host.writeJson(
            rpcError(
              request,
              -32077,
              "Credential operation failed. Check the source login, choose an unused Provider name, and verify Pi configuration access.",
            ),
          );
        }
      });
      return true;
    }
    if (request.method === "codexhost/harness/accounts/sources") {
      this.#host.dispatchReply(request, async () => {
        if (!harnessAccountSourceListParamsSchema.safeParse(request.params).success) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Invalid Harness account source list params"),
          );
          return;
        }
        await this.#host.waitForPlugins();
        const result = listHarnessAccountSources(
          this.#host.externalAdapters.values(),
          this.#host.pluginDescriptors(),
        );
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return true;
    }
    if (request.method === "codexhost/harness/accounts/inspect") {
      this.#host.dispatchReply(request, async () => {
        const params = harnessAccountInspectParamsSchema.safeParse(request.params);
        if (!params.success) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Invalid Harness account inspection params"),
          );
          return;
        }
        await this.#host.waitForPlugins();
        const adapter = this.#host.externalAdapters.get(params.data.harnessId);
        if (!adapter) {
          await this.#host.writeJson(
            rpcError(request, -32077, `Harness '${params.data.harnessId}' is unavailable`),
          );
          return;
        }
        const result = harnessAccountInspectResultSchema.parse(
          await this.#host.inspectHarnessAccount(adapter, params.data.refresh === true),
        );
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return true;
    }
    if (request.method === "codexhost/harness/accounts/list") {
      this.#host.dispatchReply(request, async () => {
        const params = harnessAccountListParamsSchema.safeParse(request.params);
        if (!params.success) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Invalid Harness account list params"),
          );
          return;
        }
        await this.#host.waitForPlugins();
        const inspections = await Promise.all(
          [...this.#host.externalAdapters.values()].map((adapter) =>
            this.#host.inspectHarnessAccount(adapter, params.data.refresh === true),
          ),
        );
        const result = harnessAccountListResultSchema.parse({
          accounts: inspections.flatMap((inspection) => listedHarnessAccounts(inspection)),
        });
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return true;
    }
    if (request.method === "codexhost/harness/inspect") {
      this.#host.dispatchReply(request, () => this.#host.inspectHarness(request));
      return true;
    }
    if (
      request.method === HARNESS_INSTALLATION_METHOD ||
      request.method === HARNESS_INSTALLATION_START_METHOD ||
      request.method === HARNESS_INSTALLATION_STATUS_METHOD
    ) {
      this.#host.dispatchReply(request, async () => {
        try {
          if (request.method !== HARNESS_INSTALLATION_STATUS_METHOD)
            await this.#host.waitForPlugins();
          const result =
            request.method === HARNESS_INSTALLATION_START_METHOD
              ? this.#installationTasks.start(request.params, this.#host.externalAdapters)
              : request.method === HARNESS_INSTALLATION_STATUS_METHOD
                ? this.#installationTasks.status(request.params)
                : await handleHarnessInstallation(request.params, this.#host.externalAdapters);
          await this.#host.writeJson(
            rpcEnvelope(request, { result: jsonValueSchema.parse(result) }),
          );
        } catch (error) {
          await this.#host.writeJson(
            rpcError(
              request,
              error instanceof HarnessInstallationError ? error.code : -32077,
              error instanceof HarnessInstallationError
                ? error.message
                : "Harness version management failed",
            ),
          );
        }
      });
      return true;
    }
    if (request.method === "codexhost/harness/web-ui/open") {
      this.#host.dispatchReply(request, () => this.#host.openHarnessWebUi(request));
      return true;
    }
    if (
      request.method === HARNESS_LAUNCH_SETTINGS_GET_METHOD ||
      request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
    ) {
      this.#host.dispatchReply(request, async () => {
        const schema =
          request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
            ? harnessLaunchSettingsSetSchema
            : harnessLaunchSettingsGetSchema;
        const params = schema.safeParse(request.params);
        if (!params.success) {
          await this.#host.writeJson(rpcError(request, -32602, "Invalid Harness launch settings"));
          return;
        }
        await this.#host.waitForPlugins();
        if (
          !this.#host
            .pluginDescriptors()
            .some((plugin) => plugin.id === params.data.harnessId && plugin.launchCommand)
        ) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Harness launch settings are unavailable"),
          );
          return;
        }
        try {
          const result =
            request.method === HARNESS_LAUNCH_SETTINGS_SET_METHOD
              ? await this.#host.launchSettings.set(
                  params.data.harnessId,
                  harnessLaunchSettingsSetSchema.parse(request.params).path,
                )
              : await this.#host.launchSettings.get(params.data.harnessId);
          await this.#host.writeJson(
            rpcEnvelope(request, { result: jsonValueSchema.parse(result) }),
          );
        } catch {
          await this.#host.writeJson(
            rpcError(
              request,
              -32602,
              "Could not read or save launch settings. Use an existing absolute installation directory on this Host, without arguments, and check configuration permissions.",
            ),
          );
        }
      });
      return true;
    }
    if (request.method === "codexhost/harness/plugins/list") {
      this.#host.dispatchReply(request, async () => {
        if (!harnessPluginListParamsSchema.safeParse(request.params).success) {
          await this.#host.writeJson(
            rpcError(request, -32602, "Invalid Harness plugin list params"),
          );
          return;
        }
        await this.#host.waitForPlugins();
        const result = harnessPluginListResultSchema.parse({
          plugins: this.#host
            .pluginDescriptors()
            .filter((plugin) => this.#host.eligibleFor(origin, "desktop", plugin.id)),
        });
        await this.#host.writeJson(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
      });
      return true;
    }
    if (isSessionImportRequest(request.method)) {
      this.#host.dispatchReply(request, () => this.#host.handleSessionImport(request));
      return true;
    }
    return false;
  }
}
