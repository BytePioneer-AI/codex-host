/** One transient choice bar attached to the manually expanded tree occurrence. */
import { useId, useLayoutEffect, useRef } from "react";
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
  const rootRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  useLayoutEffect(() => {
    const root = rootRef.current;
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
      <div className={css.cards} role="group" aria-labelledby={labelId}>
        {THREAD_TREE_STYLES.map((value) => (
          <button
            key={value}
            type="button"
            className={css.card}
            data-thread-style-choice={value}
            aria-disabled={busy}
            aria-pressed={style === value}
            onClick={() => void save(value)}
          >
            <span className={css.cardTitle}>{t(`threadTree.style.${value}`)}</span>
            <span className={css.cardSubtitle}>{t(`threadTree.style.${value}Subtitle`)}</span>
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
