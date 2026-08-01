import {
  readCodexLocaleSettings,
  setCodexLocaleOverride,
  type CodexLocaleSettings,
} from "./codex-locale-adapter.js";
import {
  codexLocaleOverrideForSettingsSelection,
  rendererSettingsLanguageSelection,
  rendererSettingsMessages,
  resolveRendererSettingsLocale,
  type RendererSettingsLanguageSelection,
  type RendererSettingsLocale,
  type RendererSettingsWritableLanguageSelection,
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
  let languageSelection: RendererSettingsLanguageSelection = "automatic";
  let languageAvailable = false;
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
    const nextShell = installRendererSettingsShell(undefined, messages, ownerWindow.document, {
      available: languageAvailable,
      selection: languageSelection,
      setSelection: setLanguageSelection,
    });
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

  const applyLanguageState = (
    nextLocale: RendererSettingsLocale,
    nextSelection: RendererSettingsLanguageSelection,
    nextAvailable: boolean,
    preserveOpen: boolean,
  ): void => {
    if (disposed) return;
    const shouldRemount =
      locale !== nextLocale ||
      languageSelection !== nextSelection ||
      languageAvailable !== nextAvailable;
    if (!shouldRemount) return;

    const reopen = preserveOpen && shell?.open === true;
    const activePageId = shell?.activePageId;
    locale = nextLocale;
    languageSelection = nextSelection;
    languageAvailable = nextAvailable;
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
    applyLanguageState(
      resolveRendererSettingsLocale([settings.preferredLocale]),
      rendererSettingsLanguageSelection(settings.localeOverride),
      settings.status === "ready",
      preserveOpen,
    );
  };

  async function setLanguageSelection(
    selection: RendererSettingsWritableLanguageSelection,
  ): Promise<void> {
    const localeOverride = codexLocaleOverrideForSettingsSelection(selection);
    await setCodexLocaleOverride(localeOverride, {
      ownerWindow,
      signal: lifecycleController.signal,
    });
    const settings = await readCodexLocaleSettings({
      ownerWindow,
      signal: lifecycleController.signal,
    });
    if (settings.status === "ready") {
      applyLocaleSettings(settings, true);
      return;
    }

    const preferredLocale = localeOverride ?? settings.preferredLocale;
    applyLanguageState(resolveRendererSettingsLocale([preferredLocale]), selection, true, true);
  }

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
