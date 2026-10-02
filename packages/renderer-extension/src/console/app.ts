import { hostRequestManager, consoleUpdateClient } from "./api.js";
import { mountConsoleAnnouncement } from "./announcement.js";
import { startAgentGroupSync } from "../agent-group-sync.js";
import { getSharedAgentGroupPreferenceStore } from "../agent-group-preference.js";
import { createConsoleConnectionDiagnostics } from "./connection-diagnostics.js";
import consoleCss from "./console.css";
import { h } from "./dom.js";
import { consoleMessages, type ConsoleMessages } from "./messages.js";
import { createOfflineHarnessesPage } from "./pages/harnesses-offline.js";
import { hostPage } from "./pages/host-required.js";
import { createOverviewPage } from "./pages/overview.js";
import { createChatPage } from "./pages/chat.js";
import { ConsoleState } from "./state.js";
import { createRendererModelClient } from "../renderer-model-client.js";
import { createRendererSessionImportClient } from "../renderer-session-import-client.js";
import accountsCss from "../settings/accounts.css";
import {
  RendererSettingsPageScope,
  type RendererSettingsPageDefinition,
} from "../settings/core.js";
import { createRendererSettingsBrandIcon, createRendererSettingsIcon } from "../settings/icons.js";
import {
  resolveRendererSettingsLocale,
  rendererSettingsMessages,
} from "../settings/localization.js";
import {
  CODEXHOST_GITHUB_REPOSITORY_URL,
  createDefaultRendererSettingsPages,
} from "../settings/pages.js";
import settingsCss from "../settings/shell.css";
import tailwindCss from "../settings/tailwind.css";

interface NavigationSection {
  label: string;
  pages: RendererSettingsPageDefinition[];
}

function required(
  pages: readonly RendererSettingsPageDefinition[],
  id: string,
): RendererSettingsPageDefinition {
  const page = pages.find((candidate) => candidate.id === id);
  if (!page) throw new Error(`Settings page ${id} is unavailable`);
  return page;
}

function statusCard(
  document: Document,
  messages: ConsoleMessages,
  state: ConsoleState,
): HTMLElement {
  const card = h(document, "div", { className: "console-status-card", role: "status" });
  const render = (): void => {
    const overview = state.overview;
    const running = overview?.inspect?.runtime.running ?? false;
    const summary = overview?.summary.state;
    const tone = state.offline
      ? "bad"
      : summary === "running"
        ? "ok"
        : summary === "integration-unavailable"
          ? "warn"
          : summary === "startup-failed" || summary === "desktop-missing"
            ? "bad"
            : "idle";
    const version = overview?.console.distribution?.version ?? overview?.console.version ?? "";
    card.replaceChildren(
      h(
        document,
        "div",
        { className: "console-status-card__row" },
        h(document, "span", { className: `console-dot is-${tone}` }),
        h(
          document,
          "span",
          { className: "console-status-card__title" },
          state.offline
            ? messages.consoleOffline
            : !overview
              ? messages.statusLoading
              : summary === "starting"
                ? messages.starting
                : running
                  ? messages.hostRunning
                  : messages.hostStopped,
        ),
      ),
      h(
        document,
        "div",
        { className: "console-status-card__meta" },
        [
          version && `codexhost ${version}`,
          overview?.inspect?.desktop && `Codex ${overview.inspect.desktop.version}`,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
  };
  render();
  state.subscribe(render);
  return card;
}

export function startConsoleApp(document: Document): void {
  const locale = resolveRendererSettingsLocale(
    navigator.languages.length > 0 ? navigator.languages : [navigator.language],
  );
  const settingsMessages = rendererSettingsMessages(locale);
  const messages = consoleMessages(locale);
  document.documentElement.lang = locale;
  document.title = `codexhost ${messages.title}`;

  const state = new ConsoleState();
  const manager = hostRequestManager();
  const modelClient = createRendererModelClient([manager]);
  if (!modelClient) throw new Error("Console Host client is unavailable");
  const stopGroupSync = startAgentGroupSync(
    getSharedAgentGroupPreferenceStore(),
    () => modelClient,
    { migrateLegacy: false },
  );
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) stopGroupSync();
  });
  const diagnostics = createConsoleConnectionDiagnostics(modelClient);
  const sessionImportClient = createRendererSessionImportClient((method, params) =>
    manager.sendRequest(method, params),
  );
  const updateClient = consoleUpdateClient();
  const settingsPages = createDefaultRendererSettingsPages(
    settingsMessages,
    () => updateClient,
    () => diagnostics,
    () => modelClient,
    () => sessionImportClient,
    null,
  );
  const navigate = (pageId: string): void => {
    window.location.hash = pageId;
  };
  const sections: NavigationSection[] = [
    {
      label: "",
      pages: [createOverviewPage(messages, state, navigate, locale), createChatPage()],
    },
    {
      label: messages.settingsSection,
      pages: [
        hostPage(
          required(settingsPages, "connections"),
          messages,
          state,
          createOfflineHarnessesPage(
            messages,
            settingsMessages.pageLabels.connections,
            () => state.overview?.inspect?.runtime.running ?? false,
          ),
        ),
        hostPage(required(settingsPages, "accounts"), messages, state),
        hostPage(required(settingsPages, "session-import"), messages, state),
        required(settingsPages, "updates"),
      ],
    },
    { label: messages.otherSection, pages: [required(settingsPages, "about")] },
  ];
  const pages = new Map(
    sections.flatMap((section) => section.pages).map((page) => [page.id, page] as const),
  );

  const root = h(document, "div", { className: "console-root" });
  root.style.colorScheme = "light dark";
  document.body.append(root);
  const shadow = root.attachShadow({ mode: "open" });
  // Constructable sheets: the page CSP forbids inline style elements.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${tailwindCss}\n${settingsCss}\n${accountsCss}\n${consoleCss}`);
  shadow.adoptedStyleSheets = [sheet];

  const navigation = h(document, "nav", {
    className: "settings-nav",
    "aria-label": settingsMessages.sectionsLabel,
  });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const section of sections) {
    if (section.label) {
      navigation.append(
        h(document, "div", { className: "settings-nav-section-label" }, section.label),
      );
    }
    for (const page of section.pages) {
      const item = h(
        document,
        "button",
        { type: "button", className: "settings-nav-button", "data-page-id": page.id },
        createRendererSettingsIcon(page.icon, 17),
        h(document, "span", {}, page.label),
      );
      item.addEventListener("click", () => navigate(page.id));
      buttons.set(page.id, item);
      navigation.append(item);
    }
  }
  navigation.append(
    h(
      document,
      "a",
      {
        className: "settings-nav-button settings-nav-star-link",
        href: CODEXHOST_GITHUB_REPOSITORY_URL,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      createRendererSettingsIcon("github", 17),
      h(document, "span", {}, messages.starOnGitHub),
    ),
  );

  const brand = h(
    document,
    "div",
    { className: "console-brand" },
    createRendererSettingsBrandIcon(28),
    h(
      document,
      "div",
      { className: "console-brand__copy" },
      h(document, "span", { className: "console-brand__name" }, "CodexHost"),
      h(document, "span", { className: "console-brand__subtitle" }, messages.title),
    ),
  );
  const announcement = h(document, "aside", { className: "console-announcement", hidden: true });
  const content = h(document, "div", { className: "settings-page__content" });
  const offlineBanner = h(
    document,
    "div",
    { className: "console-offline", role: "alert", hidden: true },
    createRendererSettingsIcon("alert", 16),
    h(document, "span", {}, `${messages.consoleOffline} · ${messages.consoleOfflineBody}`),
  );
  shadow.append(
    h(
      document,
      "div",
      { className: "console-app" },
      h(
        document,
        "aside",
        { className: "settings-sidebar console-sidebar" },
        brand,
        navigation,
        statusCard(document, messages, state),
      ),
      h(
        document,
        "main",
        { className: "settings-page console-main" },
        announcement,
        offlineBanner,
        content,
      ),
    ),
  );
  void mountConsoleAnnouncement(announcement);
  state.subscribe(() => {
    offlineBanner.hidden = !state.offline;
  });

  let scope: RendererSettingsPageScope | null = null;
  let cleanup: (() => void) | null = null;
  let activeId: string | null = null;
  const activate = (): void => {
    const requested = window.location.hash.slice(1);
    const pageId = pages.has(requested) ? requested : "overview";
    if (pageId === activeId) return;
    activeId = pageId;
    scope?.dispose();
    try {
      cleanup?.();
    } catch {
      // A page cannot block navigation.
    }
    cleanup = null;
    for (const [id, item] of buttons) {
      if (id === pageId) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    content.replaceChildren();
    const current = new RendererSettingsPageScope();
    scope = current;
    try {
      cleanup =
        pages.get(pageId)?.mount({
          content,
          signal: current.signal,
          runLatest: (operation, handlers) => current.runLatest(operation, handlers),
        }) ?? null;
    } catch {
      content.replaceChildren(
        h(document, "div", { className: "settings-page-error" }, settingsMessages.pageUnavailable),
      );
    }
  };
  const initialView = new URLSearchParams(window.location.search).get("view");
  if (initialView && pages.has(initialView) && !window.location.hash) {
    window.history.replaceState(null, "", `/#${initialView}`);
  }
  window.addEventListener("hashchange", activate);
  // Pages render from the first overview; mount once it arrives.
  const unsubscribe = state.subscribe(() => {
    unsubscribe();
    activate();
  });
  state.start();
}
