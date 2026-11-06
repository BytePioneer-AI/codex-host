/**
 * Language preference row registered into the General section item slot
 * with a bilingual label and directly visible choices. The locale feature owns its own
 * settings surface.
 */
import { useId } from "react";
import type { PropsLocale, PropsRuntime, PropsStore } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { createLanguageRowStore } from "./settings-store.ts";
import css from "./LanguageRow.module.css";

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface LanguageRowInjected {
  /** Switch the active locale (a registered locale id). */
  setLocale: (id: string) => void;
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type LanguageRowComponentProps = PropsRuntime<"settings.general.item"> &
  PropsStore<ReturnType<typeof createLanguageRowStore>> &
  PropsLocale<"settings.locale"> &
  LanguageRowInjected;

/**
 * Render the Language row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function LanguageRow({ t, setLocale, useStore }: LanguageRowComponentProps) {
  const titleId = useId();
  const active = useStore((s) => s.active);
  const options = useStore((s) => s.options);

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title} id={titleId}>
          {t("language.title")}
        </div>
      </div>
      <div className={css.choices} role="group" aria-labelledby={titleId}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={css.choice}
            lang={option.id}
            aria-pressed={option.id === active}
            onClick={() => {
              if (option.id !== active) setLocale(option.id);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
