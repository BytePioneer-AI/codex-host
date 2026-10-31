/** Tail arc and held square for the running Chat status. */
import css from "./ChatView.module.css";

/** Render the decorative running mark; the status text supplies its accessible label. */
export function RunningIndicator() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningIconMotion}>
        <svg
          width="100%"
          height="100%"
          viewBox="2 2 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16.1 5.3C11.8 2.9 6.6 5 5.1 9.4c-1.8 5.4 1.7 10.2 6.9 10.3 4.8.2 8-3.8 7.2-8.3-.4 3.2-2 5.1-4.2 5.8" />
          <rect x="9.5" y="9.1" width="4.6" height="4.6" rx="1" transform="rotate(-10 11.8 11.4)" />
        </svg>
      </span>
    </span>
  );
}
