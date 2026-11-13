/** One transient choice bar attached to the manually expanded tree occurrence. */
import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  THREAD_TREE_STYLES,
  useThreadTreeStyleSave,
  type ThreadTreeStyleProps,
} from "../ThreadTreeStyleOptions.tsx";
import { ThreadTreeStylePreview } from "./ThreadTreeStylePreview.tsx";
import css from "../ThreadTreeStyle.module.css";

export function ThreadTreeStylePrompt({
  style,
  setStyle,
  onLater,
  onExit,
  t,
}: ThreadTreeStyleProps & { onLater: () => void; onExit: () => void }) {
  const labelId = useId();
  const [focusedStyle, setFocusedStyle] = useState(style);
  const rootRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useLayoutEffect(() => {
    const root = rootRef.current;
    // A manually expanded parent may sit at the bottom of the scrollable sidebar.
    root?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    return () => {
      if (root?.contains(document.activeElement)) exitRef.current();
    };
  }, []);
  const { busy, failed, save } = useThreadTreeStyleSave(setStyle);
  return (
    <div
      ref={rootRef}
      className={css.prompt}
      data-thread-style-prompt
      role="region"
      aria-labelledby={labelId}
    >
      <div className={css.promptHeading}>
        <strong id={labelId}>{t("threadTree.style.title")}</strong>
        <button type="button" className={css.later} disabled={busy} onClick={onLater}>
          {t("threadTree.style.later")}
        </button>
      </div>
      <div
        className={css.comparison}
        role="radiogroup"
        aria-labelledby={labelId}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const value =
            event.key === "Home" || event.key === "End"
              ? THREAD_TREE_STYLES[event.key === "Home" ? 0 : 1]
              : THREAD_TREE_STYLES[focusedStyle === "summary" ? 1 : 0];
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-thread-style-choice="${value}"]`)
            ?.focus();
        }}
      >
        {THREAD_TREE_STYLES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            className={css.choice}
            data-thread-style-choice={value}
            aria-disabled={busy}
            aria-checked={style === value}
            aria-labelledby={`${labelId}-${value}`}
            aria-describedby={`${labelId}-${value}-description`}
            tabIndex={focusedStyle === value ? 0 : -1}
            onFocus={() => setFocusedStyle(value)}
            onClick={() => void save(value)}
          >
            <span className={css.choiceTitle} id={`${labelId}-${value}`}>
              {t(`threadTree.style.${value}`)}
            </span>
            <span className={css.choiceSubtitle} id={`${labelId}-${value}-description`}>
              {t(`threadTree.style.${value}Subtitle`)}
            </span>
            <ThreadTreeStylePreview style={value} t={t} />
          </button>
        ))}
      </div>
      <p className={css.hint}>{t("threadTree.style.hint")}</p>
      {failed && (
        <div className={css.error} role="alert">
          {t("threadTree.style.error")}
        </div>
      )}
    </div>
  );
}
