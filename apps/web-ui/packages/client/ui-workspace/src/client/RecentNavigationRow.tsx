/** General → Display row owned by Workspace navigation, saved only by ConfigForms. */
import { useState } from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { RecentNavigationSettings } from "./recent-navigation-settings.ts";
import css from "./RecentNavigationRow.module.css";

export interface RecentNavigationRowInjected {
  hooks: { preference: HostObservable<ConfigFormSnapshot<RecentNavigationSettings>> };
  setEnabled: (enabled: boolean) => Promise<boolean>;
}

export function RecentNavigationRow({
  usePreference,
  setEnabled,
  t,
}: PropsRuntime<"settings.general.item"> &
  PropsLocale<"workspace"> &
  InjectFace<RecentNavigationRowInjected>) {
  const enabled = usePreference((value) => value.value?.showRecentVisits ?? true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className={css.row}>
      <div>
        <div className={css.title}>{t("recent.settings.title")}</div>
        <div className={css.description}>{t("recent.settings.description")}</div>
        {failed && <div role="alert">{t("recent.settings.error")}</div>}
      </div>
      <Switch
        checked={enabled}
        disabled={busy}
        label={t("recent.settings.title")}
        onChange={(next) => {
          setBusy(true);
          setFailed(false);
          void setEnabled(next)
            .then((saved) => setFailed(!saved))
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
