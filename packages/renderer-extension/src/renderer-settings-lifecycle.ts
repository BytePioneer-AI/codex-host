import { readCodexLocaleSettings, type CodexLocaleSettings } from "./codex-locale-adapter.js";
import {
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLocale,
} from "./settings/localization.js";
import { installRendererSettingsShell, type RendererSettingsShell } from "./settings/shell.js";
import {
  installRendererSettingsHeaderTrigger,
  type RendererSettingsHeaderTriggerControl,
} from "./settings/trigger.js";

export interface RendererSettingsLifecycleControl {
  readonly locale: RendererSettingsLocale;
  refresh(): boolean;
  dispose(): void;
}

export function installRendererSettingsLifecycle(
  ownerWindow: Window = window,
): RendererSettingsLifecycleControl {
  const lifecycleController = new AbortController();
  let locale = resolveRendererSettingsLocale(ownerWindow.navigator.languages);
  let shell: RendererSettingsShell | null = null;
  let trigger: RendererSettingsHeaderTriggerControl | null = null;
  let localeRequest: Promise<void> | null = null;
  let openGeneration = 0;
  let disposed = false;

  const mount = (): {
    shell: RendererSettingsShell;
    trigger: RendererSettingsHeaderTriggerControl;
  } => {
    const messages = rendererSettingsMessages(locale);
    const nextShell = installRendererSettingsShell(undefined, messages, ownerWindow.document);
    const nextTrigger = installRendererSettingsHeaderTrigger({
      available: nextShell.supported,
      messages,
      ownerDocument: ownerWindow.document,
      onOpen(opener) {
        const generation = ++openGeneration;
        void refreshLocale().then(() => {
          if (disposed || generation !== openGeneration) return;
          const currentOpener = opener.isConnected
            ? opener
            : (trigger?.root?.querySelector<HTMLButtonElement>("button") ?? undefined);
          shell?.openSettings(currentOpener);
        });
      },
    });
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

  mount();
  void refreshLocale();

  return {
    get locale() {
      return locale;
    },
    refresh() {
      return trigger?.refresh() ?? false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      openGeneration += 1;
      lifecycleController.abort();
      trigger?.dispose();
      shell?.dispose();
      trigger = null;
      shell = null;
    },
  };
}
