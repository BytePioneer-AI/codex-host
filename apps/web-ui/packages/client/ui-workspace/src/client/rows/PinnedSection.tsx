import type { ComponentProps } from "react";
import { IconPinOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SessionNode } from "../tree.ts";
import { SessionNodeItem } from "./Rows.tsx";
import css from "./PinnedSection.module.css";

type RowProps = ComponentProps<typeof SessionNodeItem>;

/** One projection of the shared pin order. No duplicate project rows or local drag order. */
export function PinnedSection({
  rows,
  currentId,
  onOpen,
  onRenameRequest,
  renderSlot,
  t,
  revealSessionId,
  onSessionRevealed,
  followingLabel,
}: Pick<RowProps, "currentId" | "onOpen" | "onRenameRequest" | "renderSlot" | "t"> & {
  rows: readonly SessionNode[];
  revealSessionId?: RowProps["currentId"];
  onSessionRevealed: (id: SessionNode["id"]) => void;
  followingLabel: string;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div
        role="group"
        aria-label={t("section.pinned")}
        className={css.section}
        data-sidebar-pinned
      >
        <div className={css.heading}>
          <IconPinOutlineRegular size={14} />
          {t("section.pinned")}
        </div>
        {rows.map((node) => (
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
      <div className={css.heading}>{followingLabel}</div>
    </>
  );
}
