/**
 * One sidebar section header. Sections with `expanded`/`onToggle` fold their
 * rows away and become tree rows of their own (`role="treeitem"` plus
 * `aria-expanded`), so the keyboard walk reaches them and Left/Right fold the
 * section; without that pair the header is the static label that separates two
 * sections. A section may carry one `action` at the row's end — its own button,
 * not part of the fold gesture.
 */
import type { ReactNode } from "react";
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
  /** Section action rendered at the row's end. */
  action?: SectionAction;
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
  action,
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
      {action !== undefined && (
        <Tooltip label={action.label} portal>
          <button
            type="button"
            className={css.action}
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
  if (!foldable) return <div className={css.heading}>{content}</div>;
  return (
    <div
      className={css.heading}
      role="treeitem"
      tabIndex={-1}
      data-row-key={rowKey}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {content}
    </div>
  );
}
