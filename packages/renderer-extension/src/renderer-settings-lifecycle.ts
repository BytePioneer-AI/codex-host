import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import { createDefaultRendererSettingsPages, type RendererUpdateClient } from "./settings/pages.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  installRendererSettingsHeaderTrigger,
  type RendererSettingsHeaderTriggerControl,
} from "./settings/trigger.js";

export interface RendererSettingsLifecycleOptions {
  getUpdateClient?(): RendererUpdateClient | null;
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

  const refreshUpdateIndicator = (): void => {
    const client = options.getUpdateClient?.() ?? null;
    if (!client || checkedUpdateClient === client) return;
    checkedUpdateClient = client;
    const generation = ++updateCheckGeneration;
    void client
      .checkUpdate()
      .then((result) => {
        if (disposed || generation !== updateCheckGeneration) return;
        updateAvailable = result.updateAvailable;
        trigger?.setUpdateAvailable(updateAvailable);
      })
      .catch(() => {
        // Version discovery remains available from the Updates page for an explicit retry.
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
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
