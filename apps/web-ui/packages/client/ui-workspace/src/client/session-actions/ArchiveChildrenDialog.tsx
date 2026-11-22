import { useRef, useState } from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ArchiveChildrenInjected, ArchiveChildrenRequest } from "../contract/slots.ts";
import css from "../rows/WorkspaceBrowser.module.css";

type Props = PropsLocale<"workspace"> & InjectFace<ArchiveChildrenInjected>;

export function ArchiveChildrenDialog({ useArchiveChildrenRequest, ...props }: Props) {
  const request = useArchiveChildrenRequest((current) => current);
  return request ? <ArchiveChoice key={request.sessionId} request={request} {...props} /> : null;
}

function ArchiveChoice({
  request,
  choose,
  dismiss,
  t,
}: Omit<Props, "useArchiveChildrenRequest"> & { request: ArchiveChildrenRequest }) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const submit = async (include: boolean): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await choose(request, include, remember);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      title={t("archive.children.title")}
      description={t("archive.children.description", { title: request.title })}
      closeLabel={t("close")}
      onClose={() => {
        if (!submitting.current) dismiss();
      }}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={() => void submit(false)}>
            {t("archive.children.parentOnly")}
          </Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            disabled={busy}
            onClick={() => void submit(true)}
          >
            {t("archive.children.include", { n: request.children.length })}
          </Button>
        </>
      }
    >
      <ul className={css.archiveActivity}>
        {request.children.map(({ id, title }) => (
          <li key={id}>{title}</li>
        ))}
      </ul>
      <label>
        <input
          type="checkbox"
          checked={remember}
          disabled={busy}
          onChange={({ target }) => setRemember(target.checked)}
        />
        {t("archive.children.remember")}
      </label>
      {failed && (
        <div className={css.renameError} role="alert">
          {t("archive.children.preferenceFailed")}
        </div>
      )}
    </Modal>
  );
}
