/** Compose Workspace-owned phone navigation and its local General Settings row. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-connection/client";
import type { UiWorkspaceService } from "./navigation.ts";
import {
  RecentNavigation,
  RecentShortcuts,
  type RecentNavigationInjected,
} from "./RecentNavigation.tsx";
import { RecentNavigationRow, type RecentNavigationRowInjected } from "./RecentNavigationRow.tsx";
import {
  RECENT_NAVIGATION_NAMESPACE,
  recentNavigationDefaults,
  recentNavigationSchema,
  type RecentNavigationSettings,
} from "./recent-navigation-settings.ts";

export function registerRecentNavigation(ctx: Context, navigation: UiWorkspaceService): void {
  const preference = ctx.configForms.registerBrowser<RecentNavigationSettings>(
    RECENT_NAVIGATION_NAMESPACE,
    recentNavigationSchema.toJSON(),
    recentNavigationDefaults,
  );
  const setEnabled = (enabled: boolean): Promise<boolean> =>
    preference.set("showRecentVisits", enabled);
  const setIdleTimeout = (minutes: number): Promise<boolean> =>
    preference.set("tabIdleTimeoutMinutes", minutes);
  const viewport = { scrollLeft: 0 };
  ctx.inject(["uiSession", "connection"], (scope) => {
    scope.effect(() => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const check = (): void => {
        const settings = preference.getSnapshot().value;
        if (
          settings === undefined ||
          document.visibilityState !== "visible" ||
          scope.connection.state.getSnapshot() !== "connected" ||
          !settings.showRecentVisits ||
          settings.tabIdleTimeoutMinutes === 0 ||
          navigation.opening.getSnapshot().state === "loading"
        )
          return;
        const changed = navigation.recentVisits.expireInactive(
          settings.tabIdleTimeoutMinutes * 60_000,
          scope.uiSession.sessionStatus.getSnapshot(),
        );
        if (changed && navigation.recentVisits.entries.getSnapshot().length === 0)
          viewport.scrollLeft = 0;
      };
      const schedule = (): void => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        const settings = preference.getSnapshot().value;
        if (
          document.visibilityState === "visible" &&
          settings?.showRecentVisits &&
          settings.tabIdleTimeoutMinutes > 0
        ) {
          timer = setInterval(check, 60_000);
        }
      };
      // Re-arm instead of pruning immediately, allowing existing connection/catalog recovery first.
      const stop = preference.subscribe(schedule);
      document.addEventListener("visibilitychange", schedule);
      schedule();
      return () => {
        stop();
        if (timer !== undefined) clearInterval(timer);
        document.removeEventListener("visibilitychange", schedule);
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
    viewport,
    setEnabled,
  });
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
