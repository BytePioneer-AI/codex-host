/** Declarative `settingsSchema` form for unified Host extensions with optimistic revision control. */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  resolveLocalizedExtensionText,
  type DesktopExtensionSettingField,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";
import { Button, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  hostExtensionsApi,
  isHostExtensionRevisionConflictError,
} from "./web-native-extension-management-api.ts";
import {
  buildDefaultSettings,
  formatManagementError,
  mergeSettingsWithDefaults,
  type ExtensionLocale,
  type Translate,
} from "./web-extensions-helpers.ts";
import css from "./WebExtensionDetailModal.module.css";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string };

interface Props {
  extensionId: string;
  enabled: boolean;
  schema: readonly DesktopExtensionSettingField[];
  locale: ExtensionLocale;
  t: Translate;
}

export function WebExtensionSettingsForm({
  extensionId,
  enabled,
  schema,
  locale,
  t,
}: Props): ReactNode {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<JsonObject>(() => mergeSettingsWithDefaults(schema, {}));
  const [draftStrings, setDraftStrings] = useState<Record<string, string>>({});
  const [invalidKeys, setInvalidKeys] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "idle" });
  const baseId = useId();

  // Serialized write queue with `expectedSettingsRevision` optimistic concurrency.
  const latestValuesRef = useRef<JsonObject>(values);
  const settingsRevisionRef = useRef<number>(0);
  const pendingRef = useRef<JsonObject | null>(null);
  const drainingRef = useRef(false);
  const writeVersionRef = useRef(0);
  const mountedRef = useRef(true);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const syncDraftsFromValues = useCallback(
    (merged: JsonObject) => {
      const nextDrafts: Record<string, string> = {};
      for (const field of schema) {
        if (field.type === "string" || field.type === "number") {
          const val = merged[field.key];
          nextDrafts[field.key] = val === undefined || val === null ? "" : String(val);
        }
      }
      setDraftStrings(nextDrafts);
      setInvalidKeys({});
    },
    [schema],
  );

  const loadSettings = useCallback(
    (signal?: AbortSignal) => {
      setPhase("loading");
      setLoadError(null);
      setSaveStatus({ kind: "idle" });
      void hostExtensionsApi.settingsGet({ id: extensionId }, signal).then(
        (result) => {
          if (signal?.aborted || !mountedRef.current) return;
          settingsRevisionRef.current = result.settingsRevision;
          const merged = mergeSettingsWithDefaults(schema, result.values);
          latestValuesRef.current = merged;
          setValues(merged);
          syncDraftsFromValues(merged);
          setPhase("ready");
        },
        (cause: unknown) => {
          if (signal?.aborted || !mountedRef.current) return;
          setLoadError(formatManagementError(cause, t));
          setPhase("failed");
        },
      );
    },
    [extensionId, schema, syncDraftsFromValues, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings]);

  const drainWrites = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (pendingRef.current !== null) {
        const nextToSave = pendingRef.current;
        const sentVersion = writeVersionRef.current;
        pendingRef.current = null;
        try {
          const saved = await hostExtensionsApi.settingsSet({
            id: extensionId,
            expectedSettingsRevision: settingsRevisionRef.current,
            values: nextToSave,
          });
          if (!mountedRef.current) return;
          settingsRevisionRef.current = saved.settingsRevision;
          const isLatest = sentVersion === writeVersionRef.current && pendingRef.current === null;
          if (isLatest) {
            const merged = mergeSettingsWithDefaults(schema, saved.values);
            latestValuesRef.current = merged;
            setValues(merged);
            syncDraftsFromValues(merged);
            setSaveStatus({ kind: "saved" });
            if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => {
              if (mountedRef.current) {
                setSaveStatus((prev) => (prev.kind === "saved" ? { kind: "idle" } : prev));
              }
            }, 2_000);
          }
        } catch (cause: unknown) {
          if (!mountedRef.current) return;
          if (isHostExtensionRevisionConflictError(cause)) {
            pendingRef.current = null;
            setSaveStatus({
              kind: "conflict",
              message: t("extensions.settings.conflict"),
            });
            try {
              const latest = await hostExtensionsApi.settingsGet({ id: extensionId });
              if (!mountedRef.current) return;
              settingsRevisionRef.current = latest.settingsRevision;
              const merged = mergeSettingsWithDefaults(schema, latest.values);
              latestValuesRef.current = merged;
              setValues(merged);
              syncDraftsFromValues(merged);
            } catch {
              // Keep conflict banner visible.
            }
            return;
          }
          const isLatest = sentVersion === writeVersionRef.current && pendingRef.current === null;
          if (isLatest) {
            setSaveStatus({
              kind: "error",
              message: t("extensions.settings.saveFailed", {
                message: formatManagementError(cause, t),
              }),
            });
          }
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [extensionId, schema, syncDraftsFromValues, t]);

  const enqueueSave = useCallback(
    (nextValues: JsonObject) => {
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      latestValuesRef.current = nextValues;
      setValues(nextValues);
      writeVersionRef.current += 1;
      pendingRef.current = { ...nextValues };
      setSaveStatus({ kind: "saving" });
      void drainWrites();
    },
    [drainWrites],
  );

  const updateField = (key: string, value: JsonValue) => {
    enqueueSave({ ...latestValuesRef.current, [key]: value });
  };

  const handleReset = () => {
    const defaults = buildDefaultSettings(schema, latestValuesRef.current);
    syncDraftsFromValues(defaults);
    enqueueSave(defaults);
  };

  return (
    <section className={css.settingsSection} data-web-extension-settings={extensionId}>
      <div className={css.sectionHeader}>
        <div className={css.sectionHeading}>
          <h3 className={css.sectionTitle}>{t("extensions.settings.title")}</h3>
          {!enabled && (
            <span className={css.sectionNote}>{t("extensions.settings.disabledHint")}</span>
          )}
        </div>
        <div className={css.settingsHeaderRight}>
          {saveStatus.kind === "saving" && (
            <span className={css.saveStatus} role="status">
              {t("extensions.settings.saving")}
            </span>
          )}
          {saveStatus.kind === "saved" && (
            <span className={css.saveStatus} data-tone="success" role="status">
              {t("extensions.settings.saved")}
            </span>
          )}
          {phase === "ready" && (
            <Button
              variant="outline"
              size="sm"
              disabled={saveStatus.kind === "saving"}
              onClick={handleReset}
            >
              {t("extensions.settings.reset")}
            </Button>
          )}
        </div>
      </div>

      {phase === "loading" && <p className={css.hint}>{t("extensions.settings.loading")}</p>}

      {phase === "failed" && (
        <div className={css.inlineNotice} data-tone="danger" role="alert">
          <span>{t("extensions.settings.loadFailed", { message: loadError ?? "" })}</span>
          <Button variant="outline" size="sm" onClick={() => loadSettings()}>
            {t("extensions.retry")}
          </Button>
        </div>
      )}

      {saveStatus.kind === "conflict" && (
        <p className={css.inlineNotice} data-tone="warning" role="alert">
          {saveStatus.message}
        </p>
      )}

      {saveStatus.kind === "error" && (
        <p className={css.inlineNotice} data-tone="danger" role="alert">
          {saveStatus.message}
        </p>
      )}

      {phase === "ready" && (
        <div className={css.settingsList}>
          {schema.map((field) => {
            const controlId = `${baseId}-${field.key}`;
            const label = resolveLocalizedExtensionText(field.label, locale);
            const description = field.description
              ? resolveLocalizedExtensionText(field.description, locale)
              : undefined;

            return (
              <div key={field.key} className={css.settingRow} data-setting-key={field.key}>
                <div className={css.settingMeta}>
                  <label htmlFor={controlId} className={css.settingLabel}>
                    {label}
                  </label>
                  {description && <p className={css.settingDescription}>{description}</p>}
                </div>
                <div className={css.settingControl}>
                  {field.type === "boolean" && (
                    <Switch
                      label={label}
                      checked={Boolean(values[field.key])}
                      onChange={(checked) => updateField(field.key, checked)}
                    />
                  )}

                  {field.type === "string" && (
                    <input
                      id={controlId}
                      type="text"
                      className={css.settingTextInput}
                      value={draftStrings[field.key] ?? String(values[field.key] ?? "")}
                      placeholder={
                        field.placeholder
                          ? resolveLocalizedExtensionText(field.placeholder, locale)
                          : undefined
                      }
                      onChange={(event) => {
                        const next = event.currentTarget.value;
                        setDraftStrings((prev) => ({ ...prev, [field.key]: next }));
                      }}
                      onBlur={(event) => {
                        const next = event.currentTarget.value;
                        if (next !== String(latestValuesRef.current[field.key] ?? "")) {
                          updateField(field.key, next);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  )}

                  {field.type === "number" && (
                    <input
                      id={controlId}
                      type="number"
                      className={css.settingNumberInput}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={draftStrings[field.key] ?? String(values[field.key] ?? "")}
                      aria-invalid={invalidKeys[field.key] === true}
                      onChange={(event) => {
                        const raw = event.currentTarget.value;
                        setDraftStrings((prev) => ({ ...prev, [field.key]: raw }));
                        const parsed = Number(raw);
                        const invalid =
                          raw.trim() === "" ||
                          !Number.isFinite(parsed) ||
                          (field.min !== undefined && parsed < field.min) ||
                          (field.max !== undefined && parsed > field.max);
                        setInvalidKeys((prev) => ({ ...prev, [field.key]: invalid }));
                      }}
                      onBlur={(event) => {
                        const raw = event.currentTarget.value;
                        const parsed = Number(raw);
                        const invalid =
                          raw.trim() === "" ||
                          !Number.isFinite(parsed) ||
                          (field.min !== undefined && parsed < field.min) ||
                          (field.max !== undefined && parsed > field.max);
                        if (invalid) {
                          setInvalidKeys((prev) => ({ ...prev, [field.key]: true }));
                          return;
                        }
                        setInvalidKeys((prev) => ({ ...prev, [field.key]: false }));
                        if (parsed !== latestValuesRef.current[field.key]) {
                          updateField(field.key, parsed);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  )}

                  {field.type === "range" && (
                    <div className={css.settingRange}>
                      <input
                        id={controlId}
                        type="range"
                        className={css.settingSlider}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={Number(values[field.key] ?? field.min)}
                        onChange={(event) => {
                          const parsed = Number(event.currentTarget.value);
                          if (Number.isFinite(parsed)) {
                            setValues((prev) => ({ ...prev, [field.key]: parsed }));
                          }
                        }}
                        onPointerUp={(event) => {
                          const parsed = Number(event.currentTarget.value);
                          if (
                            Number.isFinite(parsed) &&
                            parsed !== latestValuesRef.current[field.key]
                          ) {
                            updateField(field.key, parsed);
                          }
                        }}
                        onKeyUp={(event) => {
                          const parsed = Number(event.currentTarget.value);
                          if (
                            Number.isFinite(parsed) &&
                            parsed !== latestValuesRef.current[field.key]
                          ) {
                            updateField(field.key, parsed);
                          }
                        }}
                        onBlur={(event) => {
                          const parsed = Number(event.currentTarget.value);
                          if (
                            Number.isFinite(parsed) &&
                            parsed !== latestValuesRef.current[field.key]
                          ) {
                            updateField(field.key, parsed);
                          }
                        }}
                      />
                      <output htmlFor={controlId} className={css.settingRangeValue}>
                        {String(values[field.key] ?? field.min)}
                      </output>
                    </div>
                  )}

                  {field.type === "select" && (
                    <select
                      id={controlId}
                      className={css.settingSelect}
                      value={String(values[field.key] ?? "")}
                      onChange={(event) => updateField(field.key, event.currentTarget.value)}
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {resolveLocalizedExtensionText(option.label, locale)}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
