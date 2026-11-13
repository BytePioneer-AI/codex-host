/** Identity and single-line title shared by sidebar rows and lightweight session navigation. */
import type { MouseEventHandler, ReactNode } from "react";
import css from "./Rows.module.css";

export function SessionRowContent({
  identity,
  ambient,
  title,
  onTitleDoubleClick,
  onIdentityClick,
  identityLabel,
  identityControls,
  identityExpanded,
  children,
}: {
  identity: ReactNode;
  ambient?: ReactNode;
  title: string;
  onTitleDoubleClick?: MouseEventHandler<HTMLSpanElement>;
  /** Set on rows that fold: the icon then toggles instead of opening the session. */
  onIdentityClick?: MouseEventHandler<HTMLElement>;
  identityLabel?: string | undefined;
  identityControls?: string | undefined;
  identityExpanded?: boolean | undefined;
  children?: ReactNode;
}) {
  const content = (
    <>
      {identity}
      <span className={css.statusOverlay}>{ambient}</span>
    </>
  );
  return (
    <>
      {onIdentityClick ? (
        <button
          type="button"
          className={`${css.slot} ${css.identityButton}`}
          onClick={onIdentityClick}
          data-thread-icon-toggle
          aria-label={identityLabel}
          aria-expanded={identityExpanded}
          aria-controls={identityControls}
        >
          {content}
        </button>
      ) : (
        <span className={css.slot}>{content}</span>
      )}
      <span data-session-title className={css.title} onDoubleClick={onTitleDoubleClick}>
        {title}
      </span>
      {children}
    </>
  );
}
