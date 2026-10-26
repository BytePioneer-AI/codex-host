/**
 * CodexHost client features, browser half: a sidebar entry that opens a page listing the native
 * sessions each installed Harness can hand over (Claude Code, Pi, ...). Importing maps the
 * native session into a Web session; its history is replayed when the conversation opens.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { registerHarnessDiscovery } from "./harness-discovery.tsx";
import { sentMessageEditApi } from "./api.ts";
import { ImportIcon } from "./ImportIcon.tsx";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionHarnessIcon } from "./SessionHarnessIcon.tsx";
import { HostConnectionStatus } from "./HostConnectionStatus.tsx";
import { HostUsageDock } from "./HostUsageDock.tsx";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import {
  THREAD_REFERENCE_SOURCE,
  localThreadId,
  threadReferenceOf,
} from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { ensureServiceWorker } from "./notifications.ts";
import { NotificationsRow } from "./NotificationsRow.tsx";
import { ImportPage, type ImportPageFace } from "./ImportPage.tsx";
import { HostSettingsSection, type HostSettingsSectionFace } from "./HostSettingsSection.tsx";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import { en, zh, type ImportLocaleKey } from "./locales.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** CodexHost import panel copy. */
    codexhostImport: ImportLocaleKey;
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = "codexhostImport";

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = "codexhost-import" as MainPanelId;

/** Services used by the panel. */
export const inject = [
  "slots",
  "locale",
  "layout",
  "uiWorkspace",
  "sessions",
  "remote",
  "inputTriggers",
  "theme",
];

/** Console settings pages shown in Web settings, after General. */
const HOST_SETTINGS_PAGES = [
  ["connections", "settings.connections"],
  ["resources", "settings.resources"],
  ["accounts", "settings.accounts"],
  ["usage-statistics", "settings.usage"],
  ["updates", "settings.updates"],
  ["about", "settings.about"],
] as const;

/**
 * Contribute the sidebar entry and its main-column page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-codexhost: dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.provide("chatMessageEditing", sentMessageEditApi);
  ctx.inject(["connection", "modelDirectories", "commandUi"], (scope) =>
    registerHarnessDiscovery(scope),
  );
  ctx.provide("chatLinks", {
    resolve: Object.assign(
      (href: string) => {
        const threadId = localThreadId(href);
        if (threadId === undefined) return;
        const targetId = threadId as SessionId;
        const localTarget = () => {
          const row = ctx.sessions.list.getSnapshot().byId[targetId];
          return row === undefined ? undefined : threadReferenceOf(row);
        };
        if (localTarget() === undefined) return;
        const destination = new URL(window.location.href);
        destination.searchParams.set("session", targetId);
        return {
          href: destination.href,
          open: () => {
            if (localTarget() !== undefined) ctx.uiWorkspace.openSession(targetId);
          },
        };
      },
      { subscribe: (listener: () => void) => ctx.sessions.list.subscribe(listener) },
    ),
  });
  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        name: THREAD_REFERENCE_SOURCE,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: (ref) => ref,
          serialize: async (ref) => ref,
        },
      }),
    "ui-codexhost: Thread reference text codec",
  );
  const face: ImportPageFace = {
    openSession: (sessionId: string) => {
      ctx.uiWorkspace.openSession(sessionId as SessionId);
    },
  };
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: () => face,
      },
      ImportPage,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 10,
        label: () => t("panel"),
        locale: NS,
      },
      ImportIcon,
    ),
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "codexhost.notifications",
        order: 5,
        locale: NS,
      },
      NotificationsRow,
    ),
  );

  const locale: HostSettingsSectionFace["locale"] = {
    get: () => ctx.locale.getLocale().active,
    subscribe: (listener) => ctx.locale.subscribe(listener),
  };
  const colorScheme: HostSettingsSectionFace["colorScheme"] = {
    get: () => ctx.theme.getTheme().active.colorScheme,
    subscribe: (listener) => ctx.on("theme/change", listener),
  };
  HOST_SETTINGS_PAGES.forEach(([pageId, label], index) => {
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: `codexhost-${pageId}`,
          order: 10 + index,
          label: () => t(label),
          locale: NS,
          inject: (): HostSettingsSectionFace => ({ pageId, locale, colorScheme }),
        },
        HostSettingsSection,
      ),
    );
  });

  ctx.slots.inject("sidebar.session.row.identity", () =>
    ctx.slots.register(
      {
        name: "sidebar.session.row.identity",
        id: "codexhost.harness",
        inject: () => ({ list: ctx.sessions.list }),
      },
      SessionHarnessIcon,
    ),
  );

  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "codexhost.connection",
        locale: NS,
        inject: () => ({ list: ctx.sessions.list }),
      },
      HostConnectionStatus,
    ),
  );
  ctx.slots.inject("conversation.composer.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.composer.dock",
        id: "codexhost.usage",
        order: 2,
        locale: NS,
      },
      HostUsageDock,
    ),
  );

  ctx.effect(
    () =>
      ctx.remote.$on("codexhost/session-bound", (draftId, threadId) => {
        if (
          (ctx.sessions.list.getSnapshot().byId[draftId as SessionId]?.retainedBy.mainView ?? 0) > 0
        )
          ctx.uiWorkspace.openSession(threadId as SessionId);
      }),
    "ui-codexhost: canonical CH identity",
  );

  // Deep links (`?session=<id>`, used by notification clicks) and service-worker messages.
  ensureServiceWorker();
  const openFromUrl = (): void => {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session");
    if (sessionId === null) return;
    url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    // Give the Session list a moment to load before revealing the target.
    setTimeout(() => {
      face.openSession(sessionId);
    }, 600);
  };
  openFromUrl();
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; sessionId?: string } | undefined;
    if (data?.type === "codexhost/open-session" && typeof data.sessionId === "string")
      face.openSession(data.sessionId);
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onMessage);
    ctx.effect(
      () => () => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
      },
      "ui-codexhost: service worker messages",
    );
  }
}
