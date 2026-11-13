/** Explicit fold control and descendant-only status, without replacing the row's own status. */
import { IconChevronDownOutlineRegular, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import type { SessionNode } from "../tree.ts";
import css from "./ThreadTreeControls.module.css";

export function ThreadTreeToggle({
  node,
  expanded,
  toggle,
  t,
}: {
  node: SessionNode;
  expanded: boolean;
  toggle: () => void;
  t: WorkspaceBrowserProps["t"];
}) {
  if (!node.tree?.descendantCount) return <span className={css.slot} aria-hidden="true" />;
  return (
    <button
      type="button"
      data-thread-toggle
      className={css.toggle}
      aria-label={t(expanded ? "threadTree.collapse" : "threadTree.expand", {
        n: node.tree.descendantCount,
      })}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
    >
      <IconChevronDownOutlineRegular size={12} className={expanded ? undefined : css.collapsed} />
      <span className={css.count} aria-hidden="true">
        {node.tree.descendantCount}
      </span>
    </button>
  );
}

export function ThreadTreeActivity({
  node,
  expanded,
  t,
}: {
  node: SessionNode;
  expanded: boolean;
  t: WorkspaceBrowserProps["t"];
}) {
  const activity = node.tree?.activity;
  if (expanded || activity === undefined) return null;
  const statuses = [
    {
      show: activity.pendingInteraction,
      state: "warning" as const,
      label: t("threadTree.pending"),
    },
    { show: activity.running, state: "ongoing" as const, label: t("threadTree.running") },
    { show: activity.completed, state: "done" as const, label: t("threadTree.completed") },
  ].filter((status) => status.show);
  if (statuses.length === 0) return null;
  return (
    <span className={css.activity} data-thread-tree-activity>
      {statuses.map(({ state, label }) => (
        <span key={state} role="img" aria-label={label} title={label}>
          <StateDot state={state} />
        </span>
      ))}
    </span>
  );
}
