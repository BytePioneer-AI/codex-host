/**
 * Session deletion: a `sidebar.workspaces.session.menu.item` danger row and a
 * `shell.overlay` confirmation dialog. When the Session has display-tree
 * children, the dialog offers deleting only the parent or deleting the whole
 * subtree (leaves first).
 */
import { useState } from "react";
import {
  Button,
  IconTrashOutlineRegular,
  MenuItemButton,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  DeleteSessionDialogProps,
  DeleteSessionInjected,
  DeleteSessionRequest,
  SessionMenuItemProps,
} from "../contract/slots.ts";
import browserCss from "../rows/WorkspaceBrowser.module.css";
import { canDeleteSession } from "./capabilities.ts";

/** Menu row (order 500): delete this Session after confirmation. */
export function DeleteSessionMenuItem({
  sessionId,
  useSessions,
  useMenuOpenState,
  requestSessionDelete,
  t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState();
  const supported = useSessions((list) => canDeleteSession(list.byId[sessionId]));
  if (!supported) return null;
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconTrashOutlineRegular size={16} />}
      onSelect={() => {
        setMenuOpen(false);
        requestSessionDelete(sessionId);
      }}
    >
      {t("menu.deleteSession")}
    </MenuItemButton>
  );
}

/** Confirmation dialog in `shell.overlay` for deleting a Session (with optional child deletion). */
export function DeleteSessionDialog({
  useDeleteRequest,
  dismiss,
  deleteSession,
  t,
}: DeleteSessionDialogProps) {
  const request = useDeleteRequest((current) => current);
  if (request === null) return null;
  return (
    <DeleteSessionForm
      key={request.sessionId}
      request={request}
      dismiss={dismiss}
      deleteSession={deleteSession}
      t={t}
    />
  );
}

function DeleteSessionForm({
  request,
  dismiss,
  deleteSession,
  t,
}: {
  request: DeleteSessionRequest;
  dismiss: () => void;
  deleteSession: DeleteSessionDialogProps["deleteSession"];
  t: DeleteSessionDialogProps["t"];
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasChildren = request.children.length > 0;
  const hasRunning = request.running || request.children.some((child) => child.running);

  const close = () => {
    if (deleting) return;
    dismiss();
  };

  const confirm = (includeChildren: boolean) => {
    setDeleting(true);
    setError(null);
    deleteSession(request, includeChildren)
      .then(() => {
        setDeleting(false);
        dismiss();
      })
      .catch((reason: unknown) => {
        setDeleting(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <Modal
      phoneSidebar
      open
      onClose={close}
      closeLabel={t("close")}
      title={t(hasChildren ? "delete.session.children.title" : "delete.session.title")}
      description={
        hasChildren
          ? t("delete.session.children.description", {
              title: request.title,
              n: request.children.length,
            })
          : t("delete.session.description", { title: request.title })
      }
      footer={
        hasChildren ? (
          <>
            <Button variant="outline" disabled={deleting} onClick={() => confirm(false)}>
              {t("delete.session.children.parentOnly")}
            </Button>
            <Button
              variant="outline"
              className={browserCss.deleteAction}
              disabled={deleting}
              onClick={() => confirm(true)}
            >
              {t("delete.session.children.include", { n: request.children.length })}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={deleting} onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              variant="outline"
              className={browserCss.deleteAction}
              disabled={deleting}
              onClick={() => confirm(false)}
            >
              {t("delete.session.action")}
            </Button>
          </>
        )
      }
    >
      {hasRunning && <p className={browserCss.deleteStatus}>{t("delete.session.runningHint")}</p>}
      {hasChildren && (
        <ul className={browserCss.archiveActivity}>
          {request.children.map(({ id, title }) => (
            <li key={id}>{title}</li>
          ))}
        </ul>
      )}
      {deleting && (
        <div className={browserCss.deleteStatus} role="status">
          {t("delete.session.pending")}
        </div>
      )}
      {error !== null && (
        <div className={browserCss.renameError} role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
