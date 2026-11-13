/** Row-leading fold control and capped ancestry guides, without shifting row identity. */
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
      {Array.from({ length: Math.min(node.tree?.depth ?? 0, 3) }, (_, level) => (
        <span
          key={level}
          aria-hidden="true"
          data-thread-guide
          className={css.guide}
          style={{
            insetInlineStart: `calc(var(--dsh-workspace-indent, 0px) + ${level * 16 + 1}px)`,
          }}
        />
      ))}
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
            <IconChevronDownOutlineRegular size={14} />
          </span>
        </button>
      )}
    </>
  );
}
