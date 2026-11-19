/** Compact, immediate-save choice used by both permanent preference entrances. */
import { useId, useRef, useState } from "react";
import { preferenceRowStyles as rowCss } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceBrowserProps } from "./contract/slots.ts";
import type { ThreadTreeCollapseStyle } from "./workspace-preferences.ts";
import css from "./ThreadTreeStyle.module.css";

export const THREAD_TREE_STYLES = ["summary", "ring"] as const;
export type ThreadTreeStyleProps = {
  style: ThreadTreeCollapseStyle;
  setStyle: (style: ThreadTreeCollapseStyle) => Promise<boolean>;
  t: WorkspaceBrowserProps["t"];
};

export function useThreadTreeStyleSave(setStyle: ThreadTreeStyleProps["setStyle"]) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  const save = async (style: ThreadTreeCollapseStyle) => {
    if (saving.current) return false;
    saving.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await setStyle(style);
      setFailed(!saved);
      return saved;
    } catch {
      setFailed(true);
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return { busy, failed, save };
}

export function ThreadTreeStyleOptions({
  style,
  setStyle,
  t,
  settings = false,
}: ThreadTreeStyleProps & { settings?: boolean }) {
  const name = useId();
  const { busy, failed, save } = useThreadTreeStyleSave(setStyle);
  return (
    <div className={settings ? rowCss.row : css.options}>
      <div className={`${rowCss.rowText} ${settings ? css.settingsText : ""}`}>
        <div className={rowCss.title} id={name}>
          {t("threadTree.style.title")}
        </div>
        {settings && (
          <div className={rowCss.description} id={`${name}-description`}>
            {t("threadTree.style.description")}
          </div>
        )}
      </div>
      <div
        className={rowCss.choices}
        role="radiogroup"
        aria-labelledby={name}
        aria-describedby={settings ? `${name}-description` : undefined}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
          ];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
          buttons[next]?.click();
        }}
      >
        {THREAD_TREE_STYLES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            className={rowCss.choice}
            aria-checked={style === value}
            aria-disabled={busy}
            tabIndex={style === value ? 0 : -1}
            onClick={() => void save(value)}
          >
            {t(`threadTree.style.${value}`)}
          </button>
        ))}
      </div>
      {failed && (
        <div className={css.error} role="alert">
          {t("threadTree.style.error")}
        </div>
      )}
    </div>
  );
}
