/** Workspace-owned browser preference; not part of any Host settings schema. */
import z from "@deepseek-ai/schemastery";

export interface RecentNavigationSettings {
  showRecentVisits: boolean;
}

export const RECENT_NAVIGATION_NAMESPACE = "ui-workspace";
export const recentNavigationDefaults = { showRecentVisits: true };
export const recentNavigationSchema = z.object({ showRecentVisits: z.boolean().default(true) });
