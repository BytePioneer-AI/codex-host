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
import { ImportIcon } from "./ImportIcon.tsx";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionHarnessIcon } from "./SessionHarnessIcon.tsx";
import { ensureServiceWorker } from "./notifications.ts";
import { NotificationsRow } from "./NotificationsRow.tsx";
import { ImportPage, type ImportPageFace } from "./ImportPage.tsx";
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
export const inject = ["slots", "locale", "layout", "uiWorkspace", "sessions"];

/**
 * Contribute the sidebar entry and its main-column page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-codexhost: dictionaries");
  const t = ctx.locale.bind(NS);
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
