import type { RendererUsageStatisticsRequest } from "./console/pages/usage-statistics.js";
import type { RendererUsageStatisticsHostsProvider } from "./console/usage/usage-hosts.js";
import type { RemoteConnectionsControl } from "./remote-connections-control.js";
import type { LoadedSessionsClient } from "./settings/loaded-sessions-table.js";
import type { HarnessSchedulesPageOptions } from "./settings/harness-schedules-page.js";
import { RendererMethodUnavailableError } from "./renderer-request-sender.js";
import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import {
  createDesktopExtensionPluginPagesSource,
  type RendererSettingsPluginPagesSource,
} from "./settings/desktop-extension-settings-pages.js";
import {
  createDefaultRendererSettingsPages,
  type RendererConnectionDiagnostics,
  type RendererCodexAccountClient,
  type RendererDelegationClient,
  type RendererDesktopExtensionsClient,
  type RendererUpdateClient,
} from "./settings/pages.js";
import type {
  RendererSessionImportClient,
  RendererImportedThreadOpener,
} from "./settings/session-import-page.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  installRendererSettingsRailTrigger,
  type RendererSettingsRailTriggerControl,
} from "./settings/trigger.js";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;
const PLUGIN_PAGES_SYNC_INTERVAL_MS = 5_000;

export interface RendererSettingsLifecycleOptions {
  harnessSchedules?: HarnessSchedulesPageOptions;
  getUpdateClient?(): RendererUpdateClient | null;
  getConnectionDiagnostics?(): RendererConnectionDiagnostics | null;
  getAccountClient?(): RendererCodexAccountClient | null;
  getDelegationClient?(): RendererDelegationClient | null;
  getSessionImportClient?(hostId?: string): RendererSessionImportClient | null;
  getLoadedSessionsClient?(): LoadedSessionsClient | null;
  getDesktopExtensionsClient?(): RendererDesktopExtensionsClient | null;
  getRemoteConnections?(): RemoteConnectionsControl | null;
  requestUsageStatistics?: RendererUsageStatisticsRequest;
  /** Machines the usage statistics page may read besides the local Host. */
  usageStatisticsHosts?: RendererUsageStatisticsHostsProvider;
  openImportedThread?: RendererImportedThreadOpener;
  onLocaleChange?(locale: RendererSettingsLocale): void;
}

export interface RendererSettingsLifecycleControl {
  readonly locale: RendererSettingsLocale;
  refresh(): boolean;
  dispose(): void;
}

export function installRendererSettingsLifecycle(
  ownerWindow: Window = window,
  options: RendererSettingsLifecycleOptions = {},
): RendererSettingsLifecycleControl {
  const lifecycleController = new AbortController();
  let locale = resolveRendererSettingsLocale(ownerWindow.navigator.languages);
  let shell: RendererSettingsShell | null = null;
  let pluginPages: RendererSettingsPluginPagesSource | null = null;
  let trigger: RendererSettingsRailTriggerControl | null = null;
  let localeRequest: Promise<void> | null = null;
  let checkedUpdateClient: RendererUpdateClient | null = null;
  let retryUpdateClient: RendererUpdateClient | null = null;
  let updateRetryTimer: number | null = null;
  let updateRetryAttempt = 0;
  let updateCheckGeneration = 0;
  let updateAvailable = false;
  let settingsOpen = false;
  let pluginPagesSyncTimer: number | null = null;
  let pluginPagesSyncGeneration = 0;
  let pluginPagesSyncInFlight = false;
  let openGeneration = 0;
  let disposed = false;

  const clearPluginPagesSync = (): void => {
    pluginPagesSyncGeneration += 1;
    pluginPagesSyncInFlight = false;
    if (pluginPagesSyncTimer === null) return;
    ownerWindow.clearTimeout(pluginPagesSyncTimer);
    pluginPagesSyncTimer = null;
  };

  const scheduleNextPluginPagesSync = (
    targetPluginPages: RendererSettingsPluginPagesSource,
    generation: number,
  ): void => {
    if (
      disposed ||
      !settingsOpen ||
      generation !== pluginPagesSyncGeneration ||
      pluginPages !== targetPluginPages ||
      pluginPagesSyncTimer !== null
    ) {
      return;
    }
    pluginPagesSyncTimer = ownerWindow.setTimeout(() => {
      pluginPagesSyncTimer = null;
      syncPluginPages(targetPluginPages, generation);
    }, PLUGIN_PAGES_SYNC_INTERVAL_MS);
  };

  const syncPluginPages = (
    targetPluginPages: RendererSettingsPluginPagesSource,
    generation: number,
  ): void => {
    if (
      disposed ||
      !settingsOpen ||
      generation !== pluginPagesSyncGeneration ||
      pluginPagesSyncInFlight ||
      pluginPages !== targetPluginPages
    ) {
      return;
    }
    if (ownerWindow.document?.visibilityState === "hidden") {
      scheduleNextPluginPagesSync(targetPluginPages, generation);
      return;
    }
    const client = options.getDesktopExtensionsClient?.() ?? null;
    if (!client?.listDesktopExtensions) return;
    pluginPagesSyncInFlight = true;
    let stopPolling = false;
    void client
      .listDesktopExtensions()
      .then((result) => {
        if (disposed || !settingsOpen || generation !== pluginPagesSyncGeneration) return;
        targetPluginPages.syncInstalledExtensions?.(
          result.extensions,
          result.configuration.revision,
        );
      })
      .catch((error: unknown) => {
        if (error instanceof RendererMethodUnavailableError) {
          stopPolling = true;
        }
      })
      .finally(() => {
        if (generation !== pluginPagesSyncGeneration) return;
        pluginPagesSyncInFlight = false;
        if (!stopPolling) {
          scheduleNextPluginPagesSync(targetPluginPages, generation);
        }
      });
  };

  const mount = (): {
    shell: RendererSettingsShell;
    trigger: RendererSettingsRailTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
    const schedules = options.harnessSchedules;
    const getDesktopExtensionsClient = options.getDesktopExtensionsClient ?? (() => null);
    const nextPluginPages = createDesktopExtensionPluginPagesSource({
      messages,
      getHost: () => ownerWindow.__codexhostDesktopExtensionsV1 ?? null,
      getClient: getDesktopExtensionsClient,
    });
    const definitions = createDefaultRendererSettingsPages(
      messages,
      options.getUpdateClient ?? (() => null),
      options.getConnectionDiagnostics ?? (() => null),
      options.getAccountClient ?? (() => null),
      options.getSessionImportClient ?? (() => null),
      async (threadId, signal, hostId) => {
        if (!options.openImportedThread) {
          throw new Error("Imported Thread navigation is unavailable");
        }
        await options.openImportedThread(threadId, signal, hostId);
        if (!disposed && !signal.aborted) shell?.close();
      },
      options.getLoadedSessionsClient ?? (() => null),
      options.getRemoteConnections ?? (() => null),
      options.requestUsageStatistics,
      options.usageStatisticsHosts,
      schedules
        ? {
            openSchedules: async (signal) => {
              await schedules.openSchedules(signal);
              if (!disposed && !signal.aborted) shell?.close();
            },
          }
        : undefined,
      getDesktopExtensionsClient,
      nextPluginPages,
      options.getDelegationClient ?? (() => null),
    );
    const nextShell = installRendererSettingsShell(definitions, messages, ownerWindow.document, {
      pluginPages: nextPluginPages,
      onOpenChange(open) {
        settingsOpen = open;
        trigger?.setSelected(open);
        clearPluginPagesSync();
        if (open) {
          syncPluginPages(nextPluginPages, pluginPagesSyncGeneration);
        }
      },
    });
    const nextTrigger = installRendererSettingsRailTrigger({
      available: nextShell.supported,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
        // Like a native destination, the current page ignores repeat activation.
        if (shell?.open) return;
        const generation = ++openGeneration;
        void refreshLocale().then(() => {
          if (disposed || generation !== openGeneration) return;
          const currentOpener = opener.isConnected
            ? opener
            : (trigger?.root?.querySelector<HTMLButtonElement>("button") ?? undefined);
          shell?.openSettings(currentOpener, pageId);
        });
      },
    });
    nextTrigger.setUpdateAvailable(updateAvailable);
    shell = nextShell;
    pluginPages = nextPluginPages;
    trigger = nextTrigger;
    return { shell: nextShell, trigger: nextTrigger };
  };

  const applyLanguageState = (nextLocale: RendererSettingsLocale, preserveOpen: boolean): void => {
    if (disposed) return;
    if (locale === nextLocale) return;

    const reopen = preserveOpen && shell?.open === true;
    const activePageId = shell?.activePageId;
    locale = nextLocale;
    settingsOpen = false;
    clearPluginPagesSync();
    trigger?.dispose();
    shell?.dispose();
    pluginPages?.dispose?.();
    trigger = null;
    shell = null;
    pluginPages = null;
    const mounted = mount();
    options.onLocaleChange?.(locale);

    if (reopen) {
      const opener = mounted.trigger.root?.querySelector<HTMLButtonElement>("button") ?? undefined;
      mounted.shell.openSettings(opener, activePageId);
    }
  };

  const applyLocaleSettings = (settings: CodexLocaleSettings, preserveOpen: boolean): void => {
    applyLanguageState(resolveRendererSettingsLocale([settings.preferredLocale]), preserveOpen);
  };

  const refreshLocale = (): Promise<void> => {
    if (localeRequest) return localeRequest;
    const request = readCodexLocaleSettings({
      ownerWindow,
      signal: lifecycleController.signal,
    })
      .then((settings) => {
        applyLocaleSettings(settings, false);
      })
      .catch(() => {
        // The synchronously selected browser locale remains the safe fallback.
      })
      .finally(() => {
        if (localeRequest === request) localeRequest = null;
      });
    localeRequest = request;
    return request;
  };

  const clearUpdateRetry = (): void => {
    if (updateRetryTimer === null) return;
    ownerWindow.clearTimeout(updateRetryTimer);
    updateRetryTimer = null;
  };

  const scheduleUpdateRetry = (client: RendererUpdateClient): void => {
    if (disposed || updateRetryTimer !== null) return;
    const delay = UPDATE_RETRY_DELAYS_MS[updateRetryAttempt];
    if (delay === undefined) return;
    checkedUpdateClient = null;
    updateRetryAttempt += 1;
    updateRetryTimer = ownerWindow.setTimeout(() => {
      updateRetryTimer = null;
      if (disposed || options.getUpdateClient?.() !== client) return;
      refreshUpdateIndicator();
    }, delay);
  };

  const checkUpdateWithTimeout = (client: RendererUpdateClient) =>
    new Promise<Awaited<ReturnType<RendererUpdateClient["checkUpdate"]>>>((resolve, reject) => {
      const timeout = ownerWindow.setTimeout(
        () => reject(new Error("Update indicator check timed out")),
        UPDATE_CHECK_TIMEOUT_MS,
      );
      void client.checkUpdate().then(
        (result) => {
          ownerWindow.clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          ownerWindow.clearTimeout(timeout);
          reject(error);
        },
      );
    });

  const refreshUpdateIndicator = (): void => {
    const client = options.getUpdateClient?.() ?? null;
    if (!client || checkedUpdateClient === client) return;
    if (retryUpdateClient !== client) {
      clearUpdateRetry();
      retryUpdateClient = client;
      updateRetryAttempt = 0;
    } else if (updateRetryTimer !== null) {
      return;
    }
    checkedUpdateClient = client;
    const generation = ++updateCheckGeneration;
    void checkUpdateWithTimeout(client)
      .then((result) => {
        if (disposed || generation !== updateCheckGeneration) return;
        updateAvailable = result?.updateAvailable ?? false;
        trigger?.setUpdateAvailable(updateAvailable);
        if (result === null || result.error === null) {
          updateRetryAttempt = 0;
          clearUpdateRetry();
          return;
        }
        scheduleUpdateRetry(client);
      })
      .catch(() => {
        if (disposed || generation !== updateCheckGeneration || checkedUpdateClient !== client) {
          return;
        }
        scheduleUpdateRetry(client);
      });
  };

  mount();
  void refreshLocale();
  refreshUpdateIndicator();

  return {
    get locale() {
      return locale;
    },
    refresh() {
      const refreshed = trigger?.refresh() ?? false;
      refreshUpdateIndicator();
      return refreshed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settingsOpen = false;
      openGeneration += 1;
      updateCheckGeneration += 1;
      lifecycleController.abort();
      clearPluginPagesSync();
      clearUpdateRetry();
      trigger?.dispose();
      shell?.dispose();
      pluginPages?.dispose?.();
      trigger = null;
      shell = null;
      pluginPages = null;
    },
  };
}
