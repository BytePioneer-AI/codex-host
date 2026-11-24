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
  return (
    <Modal
      phoneSidebar
      open
      title={t("archive.children.title")}
      description={t("archive.children.description", { title: request.title })}
      closeLabel={t("close")}
      onClose={dismiss}
      footer={
        <>
          <Button variant="outline" onClick={() => choose(request, false)}>
            {t("archive.children.parentOnly")}
          </Button>
          <Button
            variant="outline"
            className={css.deleteAction}
            onClick={() => choose(request, true)}
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
    </Modal>
  );
}
