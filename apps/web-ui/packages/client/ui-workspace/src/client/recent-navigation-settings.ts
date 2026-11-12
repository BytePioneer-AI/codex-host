/** Workspace-owned browser preference; not part of any Host settings schema. */
import z from "@deepseek-ai/schemastery";

export interface RecentNavigationSettings {
  showRecentVisits: boolean;
  /** Zero disables automatic closing; positive values are idle minutes. */
  tabIdleTimeoutMinutes: number;
}

export const RECENT_NAVIGATION_NAMESPACE = "ui-workspace";
export const DEFAULT_TAB_IDLE_TIMEOUT_MINUTES = 60;
export const TAB_IDLE_TIMEOUT_OPTIONS = [0, 15, 30, 60, 120, 240, 1440] as const;
export const recentNavigationDefaults = {
  showRecentVisits: true,
  tabIdleTimeoutMinutes: DEFAULT_TAB_IDLE_TIMEOUT_MINUTES,
};
export const recentNavigationSchema = z.object({
  showRecentVisits: z.boolean().default(true),
  tabIdleTimeoutMinutes: z.natural().max(1440).default(DEFAULT_TAB_IDLE_TIMEOUT_MINUTES),
});
