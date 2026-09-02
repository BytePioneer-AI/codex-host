import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererConnectionDiagnostics,
  type RendererCodexAccountClient,
  type RendererUpdateClient,
} from "./settings/pages.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  installRendererSettingsHeaderTrigger,
  type RendererSettingsHeaderTriggerControl,
} from "./settings/trigger.js";

const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000] as const;

export interface RendererSettingsLifecycleOptions {
  getUpdateClient?(): RendererUpdateClient | null;
  getConnectionDiagnostics?(): RendererConnectionDiagnostics | null;
  getAccountClient?(): RendererCodexAccountClient | null;
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
  let trigger: RendererSettingsHeaderTriggerControl | null = null;
  let localeRequest: Promise<void> | null = null;
  let checkedUpdateClient: RendererUpdateClient | null = null;
  let retryUpdateClient: RendererUpdateClient | null = null;
  let updateRetryTimer: number | null = null;
  let updateRetryAttempt = 0;
  let updateCheckGeneration = 0;
  let updateAvailable = false;
  let openGeneration = 0;
  let disposed = false;

  const mount = (): {
    shell: RendererSettingsShell;
    trigger: RendererSettingsHeaderTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
    const definitions = createDefaultRendererSettingsPages(
      messages,
      options.getUpdateClient ?? (() => null),
      options.getConnectionDiagnostics ?? (() => null),
      options.getAccountClient ?? (() => null),
    );
    const nextShell = installRendererSettingsShell(definitions, messages, ownerWindow.document);
    const nextTrigger = installRendererSettingsHeaderTrigger({
      available: nextShell.supported,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener, pageId) {
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
    trigger = nextTrigger;
    return { shell: nextShell, trigger: nextTrigger };
  };

  const applyLanguageState = (nextLocale: RendererSettingsLocale, preserveOpen: boolean): void => {
    if (disposed) return;
    if (locale === nextLocale) return;

    const reopen = preserveOpen && shell?.open === true;
    const activePageId = shell?.activePageId;
    locale = nextLocale;
    trigger?.dispose();
    shell?.dispose();
    trigger = null;
    shell = null;
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
        updateAvailable = result.updateAvailable;
        trigger?.setUpdateAvailable(updateAvailable);
        if (result.error === null) {
          updateRetryAttempt = 0;
          clearUpdateRetry();
          return;
        }
        checkedUpdateClient = null;
        scheduleUpdateRetry(client);
      })
      .catch(() => {
        if (disposed || generation !== updateCheckGeneration || checkedUpdateClient !== client) {
          return;
        }
        checkedUpdateClient = null;
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
      openGeneration += 1;
      updateCheckGeneration += 1;
      lifecycleController.abort();
      clearUpdateRetry();
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
