/** Complete browser-local Workspace preference namespace. */
import type { Context } from "@deepseek-ai/cordis";
import type { ConfigForm } from "@deepseek-ai/dsh-client-ui-settings/client";
import z from "@deepseek-ai/schemastery";
import {
  recentNavigationDefaults,
  recentNavigationFields,
  type RecentNavigationSettings,
} from "./recent-navigation-settings.ts";
import { ThreadTreeStyleRow } from "./ThreadTreeStyleRow.tsx";

export type ThreadTreeCollapseStyle = "summary" | "ring";
export interface WorkspacePreferences extends RecentNavigationSettings {
  threadTreeCollapseStyle: ThreadTreeCollapseStyle;
}
export const WORKSPACE_PREFERENCES_NAMESPACE = "ui-workspace";
export const workspacePreferenceDefaults: WorkspacePreferences = {
  ...recentNavigationDefaults,
  threadTreeCollapseStyle: "summary",
};
export const workspacePreferenceSchema = z.object({
  ...recentNavigationFields,
  threadTreeCollapseStyle: z.union(["summary", "ring"]).default("summary"),
});

export function hasExplicitTreeStyle(user: unknown): boolean {
  return (
    typeof user === "object" && user !== null && Object.hasOwn(user, "threadTreeCollapseStyle")
  );
}

export function registerWorkspacePreferences(ctx: Context): ConfigForm<WorkspacePreferences> {
  const preference = ctx.configForms.registerBrowser<WorkspacePreferences>(
    WORKSPACE_PREFERENCES_NAMESPACE,
    workspacePreferenceSchema.toJSON(),
    { ...workspacePreferenceDefaults },
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "workspace.thread-tree-style",
        order: 11.5,
        locale: "workspace",
        inject: () => ({
          hooks: { preference },
          setStyle: (style: ThreadTreeCollapseStyle) =>
            preference.set("threadTreeCollapseStyle", style),
        }),
      },
      ThreadTreeStyleRow,
    ),
  );
  return preference;
}
