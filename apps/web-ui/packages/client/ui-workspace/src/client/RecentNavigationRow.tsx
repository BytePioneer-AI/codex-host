/** General → Display preferences owned by Workspace tabs, saved only by ConfigForms. */
import { useEffect, useId, useRef, useState } from "react";
import {
  IconChevronDownOutlineRegular,
  Menu,
  Switch,
  Tag,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import {
  DEFAULT_TAB_IDLE_TIMEOUT_MINUTES,
  TAB_IDLE_TIMEOUT_OPTIONS,
  type RecentNavigationSettings,
} from "./recent-navigation-settings.ts";
import css from "./RecentNavigationRow.module.css";

export interface RecentNavigationRowInjected {
  hooks: { preference: HostObservable<ConfigFormSnapshot<RecentNavigationSettings>> };
  setEnabled: (enabled: boolean) => Promise<boolean>;
  setIdleTimeout: (minutes: number) => Promise<boolean>;
}

export function RecentNavigationRow({
  usePreference,
  setEnabled,
  setIdleTimeout,
  t,
}: PropsRuntime<"settings.general.item"> &
  PropsLocale<"workspace"> &
  InjectFace<RecentNavigationRowInjected>) {
  const preference = usePreference((value) => value.value);
  const enabled = preference?.showRecentVisits ?? true;
  const minutes = preference?.tabIdleTimeoutMinutes ?? DEFAULT_TAB_IDLE_TIMEOUT_MINUTES;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  const timeoutId = useId();
  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);
  const label = (value: number): string =>
    value === 0
      ? t("recent.timeout.off")
      : value >= 120 && value % 60 === 0
        ? t("recent.timeout.hours", { n: value / 60 })
        : t("recent.timeout.minutes", { n: value });
  const save = (write: () => Promise<boolean>): void => {
    if (saving.current) return;
    saving.current = true;
    setOpen(false);
    setBusy(true);
    setFailed(false);
    void Promise.resolve()
      .then(write)
      .then((saved) => setFailed(!saved))
      .catch(() => setFailed(true))
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  };
  return (
    <div>
      <div className={css.row}>
        <div className={css.text}>
          <div className={css.titleLine}>
            <span className={css.title}>{t("recent.settings.title")}</span>
            <Tag tone="neutral">{t("recent.settings.mobile")}</Tag>
          </div>
          <div className={css.description}>{t("recent.settings.description")}</div>
        </div>
        <Switch
          checked={enabled}
          disabled={busy}
          label={`${t("recent.settings.title")} · ${t("recent.settings.mobile")}`}
          onChange={(next) => save(() => setEnabled(next))}
        />
      </div>
      {enabled && (
        <div className={`${css.row} ${css.timeoutRow}`}>
          <div className={css.text}>
            <div className={css.title} id={`${timeoutId}-label`}>
              {t("recent.timeout.title")}
            </div>
          </div>
          <Menu
            className={css.menu}
            open={open && enabled && !busy}
            onClose={() => setOpen(false)}
            items={TAB_IDLE_TIMEOUT_OPTIONS.map((value) => ({
              id: String(value),
              label:
                value === DEFAULT_TAB_IDLE_TIMEOUT_MINUTES
                  ? t("recent.timeout.default", { value: label(value) })
                  : label(value),
            }))}
            selectedId={String(minutes)}
            onSelect={(id) => {
              const value = TAB_IDLE_TIMEOUT_OPTIONS.find((option) => String(option) === id);
              if (value !== undefined) save(() => setIdleTimeout(value));
            }}
            align="end"
            portal
            anchor={
              <button
                type="button"
                className={css.selector}
                disabled={!enabled || busy}
                aria-labelledby={`${timeoutId}-label ${timeoutId}-value`}
                aria-haspopup="menu"
                aria-expanded={open && enabled && !busy}
                onClick={() => setOpen((value) => !value)}
              >
                <span id={`${timeoutId}-value`}>{label(minutes)}</span>
                <IconChevronDownOutlineRegular size={14} />
              </button>
            }
          />
        </div>
      )}
      {failed && (
        <div className={css.error} role="alert">
          {t("recent.settings.error")}
        </div>
      )}
    </div>
  );
}
