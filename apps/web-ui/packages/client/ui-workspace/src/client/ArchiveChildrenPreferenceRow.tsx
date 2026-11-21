import { useState } from "react";
import { preferenceRowStyles as css } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import {
  archiveChildrenModes,
  type ArchiveChildrenMode,
  type WorkspacePreferences,
} from "./workspace-preferences.ts";

type ArchiveChildrenPreferenceInjected = {
  hooks: { preference: HostObservable<ConfigFormSnapshot<WorkspacePreferences>> };
  setMode: (mode: ArchiveChildrenMode) => Promise<boolean>;
};

export function ArchiveChildrenPreferenceRow({
  usePreference,
  setMode,
  t,
}: PropsRuntime<"settings.general.item"> &
  PropsLocale<"workspace"> &
  InjectFace<ArchiveChildrenPreferenceInjected>) {
  const mode = usePreference((snapshot) => snapshot.value?.archiveChildren ?? "ask");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className={css.row}>
      <label className={css.rowText}>
        <span className={css.title}>{t("archive.children.preference")}</span>
        <select
          value={mode}
          disabled={busy}
          onChange={async ({ target }) => {
            const next = archiveChildrenModes.find((value) => value === target.value);
            if (!next || next === mode) return;
            setBusy(true);
            setFailed(false);
            try {
              setFailed(!(await setMode(next)));
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {archiveChildrenModes.map((value) => (
            <option key={value} value={value}>
              {t(`archive.children.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {failed && <span role="alert">{t("archive.children.preferenceFailed")}</span>}
    </div>
  );
}
