/** Identity and single-line title shared by sidebar rows and lightweight session navigation. */
import type { MouseEventHandler, ReactNode } from "react";
import css from "./Rows.module.css";

export function SessionRowContent({
  identity,
  ambient,
  title,
  onTitleDoubleClick,
  onIdentityClick,
  children,
}: {
  identity: ReactNode;
  ambient?: ReactNode;
  title: string;
  onTitleDoubleClick?: MouseEventHandler<HTMLSpanElement>;
  /** Set on rows that fold: the icon then toggles instead of opening the session. */
  onIdentityClick?: MouseEventHandler<HTMLSpanElement>;
  children?: ReactNode;
}) {
  return (
    <>
      <span
        className={css.slot}
        onClick={onIdentityClick}
        data-thread-icon-toggle={onIdentityClick ? "" : undefined}
      >
        {identity}
        <span className={css.statusOverlay}>{ambient}</span>
      </span>
      <span data-session-title className={css.title} onDoubleClick={onTitleDoubleClick}>
        {title}
      </span>
      {children}
    </>
  );
}
