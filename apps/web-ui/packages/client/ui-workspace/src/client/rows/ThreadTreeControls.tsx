/** Title-trailing fold badge with one priority-ordered descendant activity dot. */
import { IconChevronDownOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
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
  const count = node.tree?.descendantCount ?? 0;
  if (!count) return null;
  const activity = node.tree?.activity;
  const state = expanded
    ? undefined
    : activity?.pendingInteraction
      ? "pending"
      : activity?.running
        ? "running"
        : activity?.completed
          ? "completed"
          : undefined;
  return (
    <button
      type="button"
      data-thread-toggle
      className={css.toggle}
      aria-label={t(expanded ? "threadTree.collapse" : "threadTree.expand", { n: count })}
      aria-expanded={expanded}
      aria-description={state === undefined ? undefined : t(`threadTree.${state}`)}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
    >
      <span className={css.badge}>
        {state !== undefined && (
          <span
            className={css.activity}
            data-thread-tree-activity={state}
            role="img"
            aria-label={t(`threadTree.${state}`)}
            title={t(`threadTree.${state}`)}
          />
        )}
        <span className={css.count} aria-hidden="true">
          {count > 999 ? "999+" : count}
        </span>
        <IconChevronDownOutlineRegular size={12} className={expanded ? undefined : css.collapsed} />
      </span>
    </button>
  );
}
