/** A 22px descendant ring around the sidebar's 14px Harness glyph. */
import { threadActivityPriority, type ThreadTreeActivity } from "./thread-tree-presentation.ts";
import css from "./ThreadTreeRing.module.css";

export function ThreadTreeRing({ activity }: { activity: ThreadTreeActivity }) {
  return (
    <span
      className={css.ring}
      data-thread-ring={threadActivityPriority(activity)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 22 22" fill="none">
        <circle cx="11" cy="11" r="10.25" />
      </svg>
    </span>
  );
}
