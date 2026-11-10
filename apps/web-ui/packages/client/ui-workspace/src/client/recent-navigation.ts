/** Compose Workspace-owned phone navigation and its local General Settings row. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
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
  const inject = (): RecentNavigationInjected => ({
    hooks: { visits: navigation.recentVisits.entries, recentNavigationSettings: preference },
    open: (target) => navigation.openSession(target),
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
        }),
      },
      RecentNavigationRow,
    ),
  );
}
