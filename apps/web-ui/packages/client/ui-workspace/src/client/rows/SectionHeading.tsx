/**
 * One sidebar section header. Sections with `expanded`/`onToggle` fold their
 * rows away and become tree rows of their own (`role="treeitem"` plus
 * `aria-expanded`), so the keyboard walk reaches them and Left/Right fold the
 * section; without that pair the header is the static label that separates two
 * sections. A section may carry one `action` at the row's end — its own button,
 * not part of the fold gesture.
 */
import type { DragEventHandler, ReactNode } from "react";
import { IconChevronDownOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import clsx from "clsx";
import css from "./SectionHeading.module.css";

/** The one action a section header offers, at the row's end. */
export interface SectionAction {
  /** Accessible name and tooltip. */
  label: string;
  /** Button glyph. */
  icon: ReactNode;
  /** Run the action without folding the section. */
  onActivate: () => void;
}

/** Props of {@link SectionHeading}. */
export interface SectionHeadingProps {
  /** Section name, also the row's accessible name while foldable. */
  label: string;
  /** Leading glyph, if the section carries one. */
  icon?: ReactNode;
  /** Whether the section's rows show; absent renders a static label. */
  expanded?: boolean;
  /** Fold or unfold the section. */
  onToggle?: () => void;
  /** Row key; required while foldable. */
  rowKey?: string;
  /** Optional inline trailing control rendered at the row's end without folding the section. */
  trailing?: ReactNode;
  /** Drop a dragged project on this section, including while it is folded. */
  projectDrop?:
    { active: boolean; hover: () => void; leave: () => void; drop: () => void } | undefined;
  /** Section action rendered at the row's end. */
  action?: SectionAction;
  /** Highlight the heading as an active section drop target during desktop dragover. */
  dropTarget?: boolean;
  /** Optional dragover handler when this heading accepts section drops. */
  onDragOver?: DragEventHandler<HTMLDivElement>;
  /** Optional drop handler when this heading accepts section drops. */
  onDrop?: DragEventHandler<HTMLDivElement>;
}

/**
 * Render one section header.
 * @param props - heading props.
 * @returns the header row.
 */
export function SectionHeading({
  label,
  icon,
  expanded,
  onToggle,
  rowKey,
  trailing,
  action,
  projectDrop,
  dropTarget = false,
  onDragOver,
  onDrop,
}: SectionHeadingProps) {
  const foldable = expanded !== undefined && onToggle !== undefined && rowKey !== undefined;
  const content = (
    <>
      {icon}
      <span className={css.title}>{label}</span>
      {foldable && (
        <IconChevronDownOutlineRegular
          className={expanded ? css.chevron : css.collapsed}
          size={12}
        />
      )}
      {trailing !== undefined && (
        <span
          className={css.trailing}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {trailing}
        </span>
      )}
      {action !== undefined && (
        <Tooltip label={action.label} portal>
          <button
            type="button"
            className={clsx(css.action, trailing !== undefined && css.actionAfterTrailing)}
            aria-label={action.label}
            onClick={(event) => {
              event.stopPropagation();
              action.onActivate();
            }}
          >
            {action.icon}
          </button>
        </Tooltip>
      )}
    </>
  );
  if (!foldable) {
    return (
      <div
        className={clsx(css.heading, dropTarget && css.dropTarget)}
        data-section-drop-target={dropTarget || undefined}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {content}
      </div>
    );
  }
  return (
    <div
      className={clsx(css.heading, dropTarget && css.dropTarget)}
      role="treeitem"
      tabIndex={-1}
      data-row-key={rowKey}
      data-section-drop-target={dropTarget || undefined}
      aria-label={label}
      data-project-drop-active={projectDrop?.active || undefined}
      onDragOver={
        projectDrop
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              projectDrop.hover();
            }
          : onDragOver
      }
      onDragLeave={
        projectDrop &&
        ((event) => {
          if (!(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          ))
            projectDrop.leave();
        })
      }
      onDrop={
        projectDrop
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              projectDrop.drop();
            }
          : onDrop
      }
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {content}
    </div>
  );
}
