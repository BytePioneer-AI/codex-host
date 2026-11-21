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
import { ArchiveChildrenPreferenceRow } from "./ArchiveChildrenPreferenceRow.tsx";

export type ThreadTreeCollapseStyle = "summary" | "ring";
export const archiveChildrenModes = ["ask", "always", "never"] as const;
export type ArchiveChildrenMode = (typeof archiveChildrenModes)[number];
export interface WorkspacePreferences extends RecentNavigationSettings {
  threadTreeCollapseStyle: ThreadTreeCollapseStyle;
  archiveChildren: ArchiveChildrenMode;
}
export const WORKSPACE_PREFERENCES_NAMESPACE = "ui-workspace";
export const workspacePreferenceDefaults: WorkspacePreferences = {
  ...recentNavigationDefaults,
  threadTreeCollapseStyle: "summary",
  archiveChildren: "ask",
};
export const workspacePreferenceSchema = z.object({
  ...recentNavigationFields,
  threadTreeCollapseStyle: z.union(["summary", "ring"]).default("summary"),
  archiveChildren: z.union([...archiveChildrenModes]).default("ask"),
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
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "workspace.archive-children",
        order: 11.6,
        locale: "workspace",
        inject: () => ({
          hooks: { preference },
          setMode: (mode: ArchiveChildrenMode) => preference.set("archiveChildren", mode),
        }),
      },
      ArchiveChildrenPreferenceRow,
    ),
  );
  return preference;
}
