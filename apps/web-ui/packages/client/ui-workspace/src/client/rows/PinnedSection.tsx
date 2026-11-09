import type { ComponentProps } from "react";
import { IconPinOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionNode } from "../tree.ts";
import { SessionNodeItem } from "./Rows.tsx";
import { SectionHeading } from "./SectionHeading.tsx";
import { PINNED_SECTION_KEY } from "../stores.ts";
import css from "./PinnedSection.module.css";

type RowProps = ComponentProps<typeof SessionNodeItem>;

/**
 * One projection of the shared pin order. No duplicate project rows or local
 * drag order. The section folds as a whole; the pins themselves stay in the
 * registry set while folded.
 */
export function PinnedSection({
  rows,
  currentId,
  onOpen,
  onRenameRequest,
  renderSlot,
  t,
  revealSessionId,
  onSessionRevealed,
  expanded,
  onToggle,
}: Pick<RowProps, "currentId" | "onOpen" | "onRenameRequest" | "renderSlot" | "t"> & {
  rows: readonly SessionNode[];
  revealSessionId?: RowProps["currentId"];
  onSessionRevealed: (id: SessionNode["id"]) => void;
  /** Whether the pinned rows show. */
  expanded: boolean;
  /** Fold or unfold the section. */
  onToggle: () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div role="group" aria-label={t("section.pinned")} className={css.section} data-sidebar-pinned>
      <SectionHeading
        label={t("section.pinned")}
        icon={<IconPinOutlineRegular size={14} />}
        expanded={expanded}
        onToggle={onToggle}
        rowKey={`section:${PINNED_SECTION_KEY}`}
      />
      {expanded &&
        rows.map((node) => (
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
        ))}
    </div>
  );
}
