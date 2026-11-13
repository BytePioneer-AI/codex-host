/** Row-leading fold control and capped ancestry guides, without shifting row identity. */
import { IconChevronDownOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { CSSProperties } from "react";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
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
  const { rows } = useThreadTreeView();
  const visibleDescendants =
    expanded && node.tree && node.tree.depth < 3 ? rows(node.tree.children).length : 0;
  const count = node.tree?.descendantCount ?? 0;
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
  const label = t(expanded ? "threadTree.collapse" : "threadTree.expand", { n: count });
  const description = state === undefined ? undefined : t(`threadTree.${state}`);
  return (
    <>
      {visibleDescendants > 0 && (
        <span
          aria-hidden="true"
          data-thread-guide
          className={css.guide}
          style={{ "--dsh-thread-visible-descendants": visibleDescendants } as CSSProperties}
        />
      )}
      {count > 0 && (
        <button
          type="button"
          data-thread-toggle
          className={css.toggle}
          aria-label={label}
          aria-expanded={expanded}
          aria-description={description}
          title={description ?? label}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <span
            className={`${css.chevron}${expanded ? "" : ` ${css.collapsed}`}`}
            data-thread-tree-activity={state}
          >
            <IconChevronDownOutlineRegular size={12} />
          </span>
        </button>
      )}
    </>
  );
}
