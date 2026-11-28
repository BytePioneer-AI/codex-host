/** Compose Workspace-owned phone navigation and its local General Settings row. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import type { UiWorkspaceService } from "./navigation.ts";
import {
  PhoneHeaderNewSession,
  type PhoneHeaderNewSessionInjected,
} from "./PhoneHeaderNewSession.tsx";
import {
  RecentNavigation,
  RecentShortcuts,
  type RecentNavigationInjected,
} from "./RecentNavigation.tsx";
import { RecentNavigationRow, type RecentNavigationRowInjected } from "./RecentNavigationRow.tsx";
import type { RecentNavigationSettings } from "./recent-navigation-settings.ts";

/** Upper bound between checks while visible, guarding against mobile suspension skipping visibility events. */
const MAX_IDLE_CHECK_DELAY_MS = 60_000;

export function registerRecentNavigation(
  ctx: Context,
  navigation: UiWorkspaceService,
  preference: ConfigForm<RecentNavigationSettings>,
): void {
  const setEnabled = (enabled: boolean): Promise<boolean> =>
    preference.set("showRecentVisits", enabled);
  const setIdleTimeout = (minutes: number): Promise<boolean> =>
    preference.set("tabIdleTimeoutMinutes", minutes);
  const viewport = { scrollLeft: 0 };
  ctx.inject(["uiSession", "connection", "sessions", "workspaces"], (scope) => {
    scope.effect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let syncing = false;
      let resyncRequested = false;
      let disposed = false;
      let lastEnabled = preference.getSnapshot().value?.showRecentVisits;
      let lastTimeoutMinutes = preference.getSnapshot().value?.tabIdleTimeoutMinutes;

      const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };

      const sync = (): void => {
        if (disposed) return;
        if (syncing) {
          resyncRequested = true;
          return;
        }
        syncing = true;
        try {
          do {
            resyncRequested = false;
            clearTimer();
            const settings = preference.getSnapshot().value;
            if (
              settings === undefined ||
              !settings.showRecentVisits ||
              settings.tabIdleTimeoutMinutes <= 0 ||
              document.visibilityState !== "visible" ||
              scope.connection.state.getSnapshot() !== "connected" ||
              navigation.opening.getSnapshot().state === "loading"
            )
              continue;
            const { changed, nextDelayMs } = navigation.recentVisits.expireInactive(
              settings.tabIdleTimeoutMinutes * 60_000,
              scope.uiSession.sessionStatus.getSnapshot(),
            );
            if (changed && navigation.recentVisits.entries.getSnapshot().length === 0)
              viewport.scrollLeft = 0;
            if (!disposed && !resyncRequested && nextDelayMs !== undefined) {
              timer = setTimeout(sync, Math.max(1, Math.min(nextDelayMs, MAX_IDLE_CHECK_DELAY_MS)));
            }
          } while (resyncRequested && !disposed);
        } finally {
          syncing = false;
        }
      };

      const onPreferenceChange = (): void => {
        const settings = preference.getSnapshot().value;
        const enabled = settings?.showRecentVisits;
        const timeoutMinutes = settings?.tabIdleTimeoutMinutes;
        if (enabled === lastEnabled && timeoutMinutes === lastTimeoutMinutes) return;
        lastEnabled = enabled;
        lastTimeoutMinutes = timeoutMinutes;
        sync();
      };

      const disposers = [
        preference.subscribe(onPreferenceChange),
        scope.connection.state.subscribe(sync),
        navigation.opening.subscribe(sync),
        navigation.recentVisits.entries.subscribe(sync),
        scope.uiSession.sessionStatus.subscribe(sync),
        scope.sessions.list.subscribe(sync),
        scope.workspaces.list.subscribe(sync),
      ];
      document.addEventListener("visibilitychange", sync);
      window.addEventListener("pageshow", sync);
      sync();
      return () => {
        disposed = true;
        clearTimer();
        for (const dispose of disposers) dispose();
        document.removeEventListener("visibilitychange", sync);
        window.removeEventListener("pageshow", sync);
      };
    }, "ui-workspace: idle session tabs");
  });
  const inject = (): RecentNavigationInjected => ({
    hooks: { visits: navigation.recentVisits.entries, recentNavigationSettings: preference },
    open: (target) => navigation.openSession(target),
    close: (sessionId) => {
      navigation.closeSessionTab(sessionId);
      if (navigation.recentVisits.entries.getSnapshot().length === 0) viewport.scrollLeft = 0;
    },
    closeAll: () => {
      navigation.closeAllSessionTabs();
      viewport.scrollLeft = 0;
    },
    viewport,
    setEnabled,
  });
  ctx.slots.inject("conversation.header.trailing", () =>
    ctx.slots.register(
      {
        name: "conversation.header.trailing",
        locale: "workspace",
        inject: (): PhoneHeaderNewSessionInjected => ({
          startSession: () => navigation.startSession(),
          hooks: { shortcuts: ctx.shortcuts.catalog },
        }),
      },
      PhoneHeaderNewSession,
    ),
  );
  ctx.slots.inject("conversation.header.navigation", () =>
    ctx.slots.register(
      {
        name: "conversation.header.navigation",
        locale: "workspace",
        inject,
      },
      RecentNavigation,
    ),
  );
  ctx.slots.inject("conversation.header.shortcuts", () =>
    ctx.slots.register(
      {
        name: "conversation.header.shortcuts",
        locale: "workspace",
        inject,
        children: {
          "workspace.recent.shortcut.identity": { kind: "list", scope: "root" },
        },
      },
      RecentShortcuts,
    ),
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "workspace.recent-navigation",
        order: 12,
        locale: "workspace",
        inject: (): RecentNavigationRowInjected => ({
          hooks: { preference },
          setEnabled,
          setIdleTimeout,
        }),
      },
      RecentNavigationRow,
    ),
  );
}
