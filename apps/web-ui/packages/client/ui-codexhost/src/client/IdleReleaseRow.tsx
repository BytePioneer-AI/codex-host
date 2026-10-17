import { useEffect, useState } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./NotificationsRow.module.css";
import { preferencesApi } from "./api.ts";

export function IdleReleaseRow({
  t,
  subscribe,
}: PropsLocale<"codexhostImport"> & { subscribe: (listener: () => void) => () => void }) {
  const [policy, setPolicy] = useState({ enabled: false, timeoutMinutes: 30 });
  const [available, setAvailable] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const result = await preferencesApi.get();
        if (!disposed && current === generation) {
          setPolicy(result.idleRelease);
          setAvailable(result.idleReleaseAvailable);
          setReady(true);
          setError("");
        }
      } catch (error) {
        if (!disposed && current === generation) {
          setReady(false);
          setError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    const remove = subscribe(() => {
      void refresh();
    });
    void refresh();
    return () => {
      disposed = true;
      remove();
    };
  }, [subscribe]);
  const save = async (next: typeof policy) => {
    setSaving(true);
    setError("");
    try {
      await preferencesApi.setIdleRelease(next);
      const result = await preferencesApi.get();
      setPolicy(result.idleRelease);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  if (!available) return null;
  return (
    <section className={css.row}>
      <div className={css.rowText}>
        <label className={css.title}>
          <input
            type="checkbox"
            checked={policy.enabled}
            disabled={!ready || saving}
            onChange={(event) => {
              void save({ ...policy, enabled: event.target.checked });
            }}
          />
          {t("preferences.idle.title")}
        </label>
        <p className={css.desc}>{t("preferences.idle.description")}</p>
      </div>
      {policy.enabled && (
        <label className={css.desc}>
          {t("preferences.idle.minutes")}
          <input
            type="number"
            min={5}
            max={1440}
            defaultValue={policy.timeoutMinutes}
            key={policy.timeoutMinutes}
            disabled={saving}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isInteger(value) &&
                value >= 5 &&
                value <= 1440 &&
                value !== policy.timeoutMinutes
              )
                void save({ ...policy, timeoutMinutes: value });
            }}
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
