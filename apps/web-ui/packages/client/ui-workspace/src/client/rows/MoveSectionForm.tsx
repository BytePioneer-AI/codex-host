import { useRef, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import css from "./WorkspaceBrowser.module.css";

export function MoveSectionForm({
  current,
  sections,
  dismiss,
  move,
  defaultLabel,
  failedLabel,
  t,
}: PropsLocale<"workspace"> & {
  current: string;
  sections: readonly WorkspaceThreadSection[];
  dismiss: () => void;
  move: (target: string | null) => Promise<void>;
  defaultLabel: string;
  failedLabel: string;
}) {
  const [choice, setChoice] = useState<string>();
  // A refreshed sidebar can move the project or remove a destination while this dialog is open.
  const target = choice ?? current;
  const targetMissing = target !== "" && !sections.some(({ id }) => id === target);
  const canMove = target !== current && !targetMissing;
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const close = () => {
    if (!pending.current) dismiss();
  };
  const submit = async () => {
    if (pending.current || !canMove) return;
    pending.current = true;
    setMoving(true);
    setFailed(false);
    try {
      await move(target || null);
      dismiss();
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
          <Button variant="outline" disabled={moving} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={moving || !canMove} onClick={() => void submit()}>
            {t("section.move")}
          </Button>
        </>
      }
    >
      <select
        className={css.renameInput}
        aria-label={t("section.destination")}
        value={target}
        disabled={moving}
        data-modal-autofocus
        onChange={({ target }) => setChoice(target.value)}
      >
        {targetMissing && (
          <option value={target} disabled>
            {t("section.destination")}
          </option>
        )}
        <option value="">{defaultLabel}</option>
        {sections.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {failed && (
        <div className={css.renameError} role="alert">
          {failedLabel}
        </div>
      )}
    </Modal>
  );
}
