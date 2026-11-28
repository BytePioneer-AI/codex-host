import { useRef, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import css from "./WorkspaceBrowser.module.css";
import { resolveMoveSectionDialogState } from "./section-dnd.ts";

export function MoveSectionForm({
  current,
  sections,
  dismiss,
  move,
  defaultLabel,
  failedLabel,
  busy = false,
  disabled = false,
  blockedMessage,
  deletedTargetLabel,
  t,
}: PropsLocale<"workspace"> & {
  current: string;
  sections: readonly WorkspaceThreadSection[];
  dismiss: () => void;
  move: (target: string | null) => Promise<void | false>;
  defaultLabel: string;
  failedLabel: string;
  busy?: boolean;
  disabled?: boolean;
  blockedMessage?: string;
  deletedTargetLabel?: string;
}) {
  const [choice, setChoice] = useState<string>();
  const [moving, setMoving] = useState(false);
  const active = busy || moving;
  const { effectiveTarget, targetDeleted, canSubmit } = resolveMoveSectionDialogState(
    current,
    sections,
    choice,
    active || disabled,
  );
  const [failed, setFailed] = useState(false);
  const message =
    blockedMessage ??
    (targetDeleted ? deletedTargetLabel : undefined) ??
    (failed ? failedLabel : undefined);
  const pending = useRef(false);
  const close = () => {
    if (!pending.current && !busy) dismiss();
  };
  const submit = async () => {
    if (pending.current || !canSubmit) return;
    pending.current = true;
    setMoving(true);
    setFailed(false);
    try {
      if ((await move(effectiveTarget || null)) !== false) dismiss();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setMoving(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      title={t("menu.moveToSection")}
      closeLabel={t("close")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" disabled={active} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {t("section.move")}
          </Button>
        </>
      }
    >
      <select
        className={css.renameInput}
        aria-label={t("section.destination")}
        value={effectiveTarget}
        disabled={active || disabled}
        data-modal-autofocus
        onChange={({ target }) => {
          setChoice(target.value);
          if (deletedTargetLabel !== undefined) setFailed(false);
        }}
      >
        {targetDeleted && (
          <option value={effectiveTarget} disabled>
            {t(
              deletedTargetLabel === undefined
                ? "section.destination"
                : "section.targetDeletedOption",
            )}
          </option>
        )}
        <option value="">{defaultLabel}</option>
        {sections.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {message !== undefined && (
        <div className={css.renameError} role="alert">
          {message}
        </div>
      )}
    </Modal>
  );
}
