/** Summary text shared by the fold control and non-interactive style samples. */
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { threadActivitySegments, type ThreadTreeActivity } from "./thread-tree-presentation.ts";

export function ThreadTreeSummaryContent({
  count,
  activity,
  t,
}: {
  count: number;
  activity: ThreadTreeActivity;
  t: WorkspaceBrowserProps["t"];
}) {
  return (
    <>
      {t("threadTree.children", { n: count })}
      {threadActivitySegments(activity)
        .filter((s) => s.count > 0)
        .map((s) => (
          <span key={s.state} data-thread-tree-activity={s.state}>
            {` · ${t(`threadTree.${s.state}`, { n: s.count })}`}
          </span>
        ))}
    </>
  );
}
