/** Nested display groups keep ancestry guides independent of row and subtree heights. */
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { WorkspaceBrowserProps } from "../contract/slots.ts";
import { useThreadTreeView } from "./ThreadTreeView.tsx";
import type { SessionNode } from "../tree.ts";
import css from "./ThreadTreeControls.module.css";
import { threadTreeSummary } from "./thread-tree-presentation.ts";
import { ThreadTreeSummaryContent } from "./ThreadTreeSummaryContent.tsx";
import { ThreadTreeStylePrompt } from "./ThreadTreeStylePrompt.tsx";

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
  const { expansion, stylePrompt, dismissStylePrompt, collapseStyle, setCollapseStyle, t } =
    useThreadTreeView();
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
          style={{ "--dsh-thread-guide-indent": `${Math.min(depth, 3) * 24}px` } as CSSProperties}
        >
          {expanded && <ThreadTreeRows roots={children}>{renderRow}</ThreadTreeRows>}
        </div>
      )}
      {expanded && stylePrompt === groupId && (
        <ThreadTreeStylePrompt
          style={collapseStyle}
          setStyle={setCollapseStyle}
          onLater={dismissStylePrompt}
          onExit={() =>
            document
              .querySelector<HTMLElement>(
                `[data-thread-icon-toggle][aria-controls="${CSS.escape(groupId)}"]`,
              )
              ?.focus({ preventScroll: true })
          }
          t={t}
        />
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (button !== null && document.activeElement === button)
        button
          .closest("[data-row-key]")
          ?.querySelector<HTMLElement>("[data-thread-icon-toggle]")
          ?.focus({ preventScroll: true });
    };
  }, []);
  const tree = node.tree;
  if (!tree || tree.descendantCount === 0) return null;
  const summary = threadTreeSummary(tree.descendantCount, tree.activity, t);
  return (
    <button
      ref={buttonRef}
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
      <ThreadTreeSummaryContent count={tree.descendantCount} activity={tree.activity} t={t} />
    </button>
  );
}
