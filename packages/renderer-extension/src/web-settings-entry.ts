/**
 * Settings pages for the Web UI: the console's pages, mounted one at a time
 * into a Web settings section and backed by the Web client channel instead of
 * the console server.
 */
import { createConsoleConnectionDiagnostics } from "./console/connection-diagnostics.js";
import consoleComponentsCss from "./console/components.css";
import usageCss from "./console/usage/usage.css";
import { startAgentGroupSync } from "./agent-group-sync.js";
import { getSharedAgentGroupPreferenceStore } from "./agent-group-preference.js";
import { installRendererHarnessPreferenceSync } from "./renderer-harness-preferences.js";
import { installIdleReleasePreferenceSync } from "./renderer-idle-release-preference.js";
import { createRendererModelClient, type RendererModelClient } from "./renderer-model-client.js";
import coloredBrandCss from "./renderer-brand-mark.css";
import accountsCss from "./settings/accounts.css";
import { RendererSettingsPageScope, type RendererSettingsPageDefinition } from "./settings/core.js";
import { mountIdleReleaseControls } from "./settings/idle-release-controls.js";
import {
  resolveRendererSettingsLocale,
  rendererSettingsMessages,
  type RendererSettingsMessages,
} from "./settings/localization.js";
import { createDefaultRendererSettingsPages } from "./settings/pages.js";
import settingsCss from "./settings/shell.css";
import tailwindCss from "./settings/tailwind.css";

/** The Web settings modal supplies padding and width; compact layout follows the page width. */
const WEB_LAYOUT_CSS = `.settings-page { background: transparent; overflow: visible; container: codexhost-settings-page / inline-size; }
.settings-page__content { width: 100%; padding: 0; }`;

interface WebSettingsMountOptions {
  locale: string;
  colorScheme: "light" | "dark";
}

/** Host requests through the Web server's authenticated client channel. */
function webRequestManager(): {
  sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown>;
} {
  return {
    async sendRequest(method, params, options) {
      const response = await fetch("api/ch/v1/rpc", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: params ?? {} }),
        ...(options instanceof AbortSignal ? { signal: options } : {}),
      });
      const reply = (await response.json().catch(() => null)) as {
        result?: unknown;
        error?: { code?: number; message?: string };
      } | null;
      if (!response.ok || !reply || reply.error) {
        throw Object.assign(new Error(reply?.error?.message ?? `HTTP ${response.status}`), {
          code: reply?.error?.code,
        });
      }
      return reply.result;
    },
  };
}

/** The GUI's idle release group (switch, timeout, loaded sessions) as its own Web section. */
function resourcesPage(
  messages: RendererSettingsMessages,
  client: RendererModelClient,
): RendererSettingsPageDefinition {
  return {
    id: "resources",
    label: messages.idleReleaseSection,
    icon: "settings",
    mount(context) {
      const idleRelease = installIdleReleasePreferenceSync(window);
      const disposeControls = mountIdleReleaseControls(context, messages, () => client);
      const preferences = installRendererHarnessPreferenceSync(window);
      preferences.connect("local", client);
      idleRelease.connect(client);
      return () => {
        disposeControls();
        preferences.dispose();
        idleRelease.dispose();
      };
    },
  };
}

function mount(pageId: string, host: HTMLElement, options: WebSettingsMountOptions): () => void {
  const messages = rendererSettingsMessages(resolveRendererSettingsLocale([options.locale]));
  const manager = webRequestManager();
  const modelClient = createRendererModelClient([manager]);
  if (!modelClient) throw new Error("Web Host client is unavailable");
  const stopGroupSync = startAgentGroupSync(
    getSharedAgentGroupPreferenceStore(),
    () => modelClient,
    { migrateLegacy: false },
  );
  const diagnostics = createConsoleConnectionDiagnostics(modelClient);
  const updateClient = {
    checkUpdate: () => modelClient.checkUpdate(),
    startUpdate: () => modelClient.startUpdate(),
    readUpdateStatus: () => modelClient.readUpdateStatus(),
  };
  const page = [
    ...createDefaultRendererSettingsPages(
      messages,
      () => updateClient,
      () => diagnostics,
      () => modelClient,
      () => null,
      null,
      () => null,
      () => null,
      (method, params) => manager.sendRequest(method, params),
    ),
    resourcesPage(messages, modelClient),
  ].find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Settings page ${pageId} is unavailable`);

  host.style.colorScheme = options.colorScheme;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    `${tailwindCss}\n${settingsCss}\n${accountsCss}\n${consoleComponentsCss}\n${usageCss}\n${coloredBrandCss}\n${WEB_LAYOUT_CSS}`,
  );
  shadow.adoptedStyleSheets = [sheet];
  const content = document.createElement("div");
  content.className = "settings-page__content";
  const root = document.createElement("div");
  root.className = "settings-page";
  root.append(content);
  shadow.replaceChildren(root);

  const scope = new RendererSettingsPageScope();
  let cleanup: (() => void) | undefined;
  try {
    cleanup = page.mount({
      content,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
  } catch {
    content.textContent = messages.pageUnavailable;
  }
  return () => {
    scope.dispose();
    try {
      cleanup?.();
    } catch {
      // A page cannot block closing settings.
    }
    stopGroupSync();
    shadow.replaceChildren();
  };
}

(
  window as unknown as { __codexhostWebSettingsV1?: { mount: typeof mount } }
).__codexhostWebSettingsV1 = { mount };
