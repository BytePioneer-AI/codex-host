/** Session-scoped native permissions: retain Adapter labels, descriptions, risk and creation scope. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconShieldOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  RiskConfirmation,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { NativePermissionMode } from "./native.ts";
import { accessEn, PERMISSION_ACCESS_NS, type PermissionAccessKey } from "./locales.ts";
import css from "./PermissionSelect.module.css";

/** Shield with an exclamation mark: the trigger glyph of a dangerous mode. */
const ShieldAlertIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M8 1.75 2.75 3.6v3.9c0 3.1 2.1 5.4 5.25 6.75 3.15-1.35 5.25-3.65 5.25-6.75V3.6L8 1.75Z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M8 5.6v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <circle cx="8" cy="10.6" r="0.75" fill="currentColor" />
  </svg>
);

export interface PermissionSelectInjected {
  /** Send the native mode ID through the existing command path and surface rejection. */
  select: (modeId: string) => Promise<boolean>;
}

export type PermissionSelectProps = PropsRuntime<"conversation.input.permission"> &
  InjectFace<PermissionSelectInjected> &
  PropsLocale<typeof PERMISSION_ACCESS_NS>;

export function PermissionSelect({ locked, select, useProjection, t }: PermissionSelectProps) {
  const selection = useProjection("permissions");
  const native = useProjection("nativePermissions");
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<NativePermissionMode | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<{ text: string; seq: number } | null>(null);
  const unavailable = locked || native?.locked === true;

  useEffect(() => {
    if (
      !unavailable &&
      native?.selectable &&
      native.catalog &&
      (confirmation === null || native.catalog.modes.some((mode) => mode.id === confirmation.id))
    )
      return;
    setOpen(false);
    setConfirmation(null);
    setAcknowledged(false);
  }, [native, unavailable, confirmation]);

  if (selection === undefined || !native?.selectable || native.catalog === null) return null;
  const modes = native.catalog.modes.map((mode) => {
    const key = `codex.${mode.id}` as PermissionAccessKey;
    return native.harnessId === "codex" && Object.hasOwn(accessEn, key)
      ? { ...mode, label: t(key) }
      : mode;
  });
  const current = modes.find((mode) => mode.id === selection.currentValue);
  const followsCodexSettings = native.harnessId === "codex" && selection.currentValue === "";
  const label =
    current?.label ?? t(followsCodexSettings ? "codex.configuration" : "native.configuration");
  const unmatchedDescription = t(
    followsCodexSettings ? "codex.configuration.description" : "native.configuration.description",
  );
  const busy = pick !== null || confirmation !== null;
  const closeConfirmation = () => {
    setAcknowledged(false);
    setConfirmation(null);
  };
  const submit = (id: string): void => {
    setPick(id);
    void select(id)
      .catch((cause: unknown) => {
        const text = cause instanceof Error ? cause.message : String(cause);
        setError((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));
      })
      .finally(() => setPick(null));
  };

  return (
    <>
      <Menu
        open={open}
        portal
        side="top"
        selectedId={selection.currentValue}
        items={modes.map((mode) => ({
          id: mode.id,
          label: (
            <span className={clsx(css.optionCopy, mode.dangerous && css.dangerous)}>
              <span>{mode.label}</span>
              {mode.description ? (
                <span className={css.description}>{mode.description}</span>
              ) : null}
            </span>
          ),
          ...(mode.dangerous ? { icon: <IconWarningOutlineRegular size={16} /> } : {}),
        }))}
        onSelect={(id) => {
          setOpen(false);
          if (unavailable || busy || id === selection.currentValue) return;
          const mode = modes.find((item) => item.id === id);
          if (!mode) return;
          if (mode.dangerous) {
            setAcknowledged(false);
            setConfirmation(mode);
          } else submit(id);
        }}
        onClose={() => setOpen(false)}
        footer={
          native.scope === "atCreate"
            ? [{ type: "label", id: "scope", text: t("native.atCreate") }]
            : []
        }
        anchor={
          <button
            type="button"
            className={clsx(css.trigger, current?.dangerous && css.triggerDangerous)}
            aria-label={t("mode", { name: label })}
            title={
              native.locked
                ? t("native.atCreate")
                : current
                  ? current.description
                  : unmatchedDescription
            }
            disabled={unavailable || busy}
            onClick={() => setOpen(!open)}
          >
            <span className={css.triggerIcon}>
              {current?.dangerous ? <ShieldAlertIcon /> : <IconShieldOutlineRegular />}
            </span>
            <span className={css.triggerLabel}>{label}</span>
            <span className={clsx(css.chevron, open && css.chevronOpen)}>
              <IconChevronDownOutlineRegular />
            </span>
          </button>
        }
      />
      {confirmation ? (
        <RiskConfirmation
          open
          title={t("native.confirm.title", { name: confirmation.label })}
          description={confirmation.description ?? t("native.confirm.description")}
          acknowledgeLabel={t("confirm.acknowledge")}
          cancelLabel={t("confirm.cancel")}
          closeLabel={t("close")}
          confirmLabel={t("native.confirm.enable")}
          acknowledged={acknowledged}
          disabled={unavailable}
          onAcknowledgedChange={setAcknowledged}
          onCancel={closeConfirmation}
          onConfirm={() => {
            const id = confirmation.id;
            closeConfirmation();
            submit(id);
          }}
        />
      ) : null}
      {error ? (
        <Toast
          key={error.seq}
          text={t("native.error", { message: error.text })}
          icon={<IconWarningOutlineRegular />}
          onDone={() => setError(null)}
        />
      ) : null}
    </>
  );
}
