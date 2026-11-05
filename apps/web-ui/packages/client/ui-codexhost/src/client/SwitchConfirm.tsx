/** Confirmation shown before a connection switch changes how this computer can be reached. */
import type { ReactNode } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./ConnectDevicesSection.module.css";

export function SwitchConfirm({
  title,
  description,
  busy,
  onClose,
  onConfirm,
  t,
  children,
}: {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  t: PropsLocale<"codexhostImport">["t"];
  children?: ReactNode;
}): ReactNode {
  return (
    <Modal
      open
      title={title}
      description={description}
      closeLabel={t("connectDevices.close")}
      onClose={() => {
        if (!busy) onClose();
      }}
      className={css.confirm}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("connectDevices.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} aria-busy={busy} onClick={onConfirm}>
            {title}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
