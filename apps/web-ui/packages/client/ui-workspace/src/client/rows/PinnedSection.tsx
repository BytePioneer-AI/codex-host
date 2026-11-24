import type { ComponentProps, ReactNode } from "react";
import { IconPinOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionNode } from "../tree.ts";
import { SessionNodeItem } from "./Rows.tsx";
import { SectionHeading } from "./SectionHeading.tsx";
import { PINNED_SECTION_KEY } from "../stores.ts";
import { ThreadTreeRows } from "./ThreadTreeControls.tsx";
import css from "./PinnedSection.module.css";

type RowProps = ComponentProps<typeof SessionNodeItem>;

/**
 * One projection of the shared pin order. No duplicate project rows or local
 * drag order. The section folds as a whole; the pins themselves stay in the
 * registry set while folded.
 */
export function PinnedSection({
  rows,
  customSection,
  currentId,
  onOpen,
  onRenameRequest,
  renderSlot,
  t,
  revealSessionId,
  onSessionRevealed,
  expanded,
  onToggle,
  children,
}: Pick<RowProps, "currentId" | "onOpen" | "onRenameRequest" | "renderSlot" | "t"> & {
  rows: readonly SessionNode[];
  customSection?: { key: string; name: string };
  revealSessionId?: RowProps["currentId"];
  onSessionRevealed: (id: SessionNode["id"]) => void;
  /** Whether the pinned rows show. */
  expanded: boolean;
  /** Fold or unfold the section. */
  onToggle: () => void;
  /** Rows after the section's own Threads, shown while it is expanded (its Workspaces). */
  children?: ReactNode;
}) {
  if (rows.length === 0 && !customSection) return null;
  const label = customSection?.name ?? t("section.pinned");
  return (
    <div
      role="group"
      aria-label={label}
      className={css.section}
      data-sidebar-pinned={customSection ? undefined : true}
    >
      <SectionHeading
        label={label}
        icon={customSection ? undefined : <IconPinOutlineRegular size={14} />}
        expanded={expanded}
        onToggle={onToggle}
        rowKey={`section:${customSection?.key ?? PINNED_SECTION_KEY}`}
      />
      {expanded && (
        <ThreadTreeRows roots={rows}>
          {(node) => (
            <SessionNodeItem
              key={node.id}
              node={node}
              currentId={currentId}
              now={Date.now()}
              onOpen={onOpen}
              onRenameRequest={onRenameRequest}
              renderSlot={renderSlot}
              onReveal={node.id === revealSessionId ? () => onSessionRevealed(node.id) : undefined}
              t={t}
            />
          )}
        </ThreadTreeRows>
      )}
      {expanded && children}
    </div>
  );
}
