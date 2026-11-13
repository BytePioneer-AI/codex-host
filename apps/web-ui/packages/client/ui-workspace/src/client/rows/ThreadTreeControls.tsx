/** Nested display groups keep ancestry guides independent of row and subtree heights. */
import { createContext, useContext, useId, type CSSProperties, type ReactNode } from "react";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
import type { SessionNode } from "../tree.ts";
import css from "./ThreadTreeControls.module.css";

const ChildGroupContext = createContext<string | undefined>(undefined);
export const useThreadChildGroup = () => useContext(ChildGroupContext);

export function ThreadTreeRows({
  roots,
  children,
}: {
  roots: readonly SessionNode[];
  children: (node: SessionNode) => ReactNode;
}) {
  return roots.map((node) => <ThreadTreeBranch key={node.id} node={node} renderRow={children} />);
}

function ThreadTreeBranch({
  node,
  renderRow,
}: {
  node: SessionNode;
  renderRow: (node: SessionNode) => ReactNode;
}) {
  const groupId = useId();
  const { expansion } = useThreadTreeView();
  const expanded = expansion[node.id] === true;
  const depth = node.tree?.depth ?? 0;
  const children = node.tree?.children ?? [];
  return (
    <div className={css.branch} data-thread-branch>
      <ChildGroupContext.Provider value={groupId}>{renderRow(node)}</ChildGroupContext.Provider>
      {children.length > 0 && (
        <div
          id={groupId}
          role="group"
          hidden={!expanded}
          data-thread-guide={expanded && depth < 3 ? "" : undefined}
          className={css.children}
          style={{ "--dsh-thread-guide-indent": `${Math.min(depth, 3) * 16}px` } as CSSProperties}
        >
          {expanded && <ThreadTreeRows roots={children}>{renderRow}</ThreadTreeRows>}
        </div>
      )}
    </div>
  );
}

export function ThreadTreeSummary({
  node,
  title,
  toggle,
  t,
}: {
  node: SessionNode;
  title: string;
  toggle: () => void;
  t: WorkspaceBrowserProps["t"];
}) {
  const groupId = useThreadChildGroup();
  const tree = node.tree;
  if (!tree || tree.descendantCount === 0) return null;
  const segments = [
    { state: "running", count: tree.activity.running },
    { state: "pending", count: tree.activity.pendingInteraction },
    { state: "completed", count: tree.activity.completed },
  ] as const;
  const count = t("threadTree.children", { n: tree.descendantCount });
  const summary = [
    count,
    ...segments.filter((s) => s.count > 0).map((s) => t(`threadTree.${s.state}`, { n: s.count })),
  ].join(" · ");
  return (
    <button
      type="button"
      data-thread-summary
      className={css.summary}
      aria-label={t("threadTree.expandSummary", { title, summary })}
      aria-expanded={false}
      aria-controls={groupId}
      onClick={(event) => {
        event.stopPropagation();
        // The summary leaves the DOM on expansion; keep keyboard focus on its Thread.
        event.currentTarget
          .closest("[data-row-key]")
          ?.querySelector<HTMLElement>("[data-thread-icon-toggle]")
          ?.focus({ preventScroll: true });
        toggle();
      }}
    >
      {count}
      {segments
        .filter((s) => s.count > 0)
        .map((s) => (
          <span key={s.state} data-thread-tree-activity={s.state}>
            {` · ${t(`threadTree.${s.state}`, { n: s.count })}`}
          </span>
        ))}
    </button>
  );
}
