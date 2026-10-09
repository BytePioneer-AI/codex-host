/** Session-scoped native permissions: retain Adapter labels, descriptions, risk and creation scope. */
import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconWarningOutlineRegular,
  Menu,
  RiskConfirmation,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { NativePermissionMode } from "./native.ts";
import { PERMISSION_ACCESS_NS } from "./locales.ts";
import css from "./PermissionSelect.module.css";

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
  const current = native.catalog.modes.find((mode) => mode.id === selection.currentValue);
  const label = current?.label ?? selection.currentValue;
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
        items={native.catalog.modes.map((mode) => ({
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
          const mode = native.catalog?.modes.find((item) => item.id === id);
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
            className={css.trigger}
            aria-label={t("mode", { name: label })}
            title={native.locked ? t("native.atCreate") : current?.description}
            disabled={unavailable || busy}
            onClick={() => setOpen(!open)}
          >
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
