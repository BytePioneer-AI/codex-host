/** Descendant-only presentation shared by live rows and static style samples. */
import type { ThreadTreeInfo } from "../thread-tree.ts";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";

export type ThreadTreeActivity = ThreadTreeInfo<unknown>["activity"];
export function threadActivitySegments(activity: ThreadTreeActivity) {
  return [
    { state: "running", count: activity.running },
    { state: "pending", count: activity.pendingInteraction },
    { state: "completed", count: activity.completed },
  ] as const;
}
export function threadActivityPriority(activity: ThreadTreeActivity) {
  return activity.pendingInteraction > 0
    ? "pending"
    : activity.running > 0
      ? "running"
      : activity.completed > 0
        ? "completed"
        : "idle";
}
export function threadTreeSummary(
  count: number,
  activity: ThreadTreeActivity,
  t: WorkspaceBrowserProps["t"],
): string {
  return [
    t("threadTree.children", { n: count }),
    ...threadActivitySegments(activity)
      .filter((s) => s.count > 0)
      .map((s) => t(`threadTree.${s.state}`, { n: s.count })),
  ].join(" · ");
}
