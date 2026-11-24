import { useRef, useState } from "react";
import {
  Button,
  IconFolderCloseRegular,
  MenuItemButton,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import css from "../rows/WorkspaceBrowser.module.css";

export interface ThreadSectionMoveRequest {
  sessionId: SessionId;
  sections: readonly WorkspaceThreadSection[];
}

export interface ThreadSectionMenuInjected {
  hooks: {
    nativeThreads: HostObservable<ReadonlySet<SessionId>>;
    sectionWorkspace: HostObservable<WorkspaceSnapshot>;
  };
  requestMove: (request: ThreadSectionMoveRequest) => void;
}

export function MoveThreadSectionMenuItem({
  sessionId,
  useNativeThreads,
  useSectionWorkspace,
  useMenuOpenState,
  requestMove,
  t,
}: SessionMenuItemProps<ThreadSectionMenuInjected>) {
  const [, setMenuOpen] = useMenuOpenState();
  const nativeThread = useNativeThreads((threads) => threads.has(sessionId));
  const workspace = useSectionWorkspace((snapshot) => snapshot);
  const sections = workspace.threadSections;
  if (
    !nativeThread ||
    !sections?.length ||
    workspace.pinnedSessionIds.includes(sessionId) ||
    workspace.archivedSessionIds.includes(sessionId)
  )
    return null;
  return (
    <MenuItemButton
      icon={<IconFolderCloseRegular />}
      onSelect={() => {
        setMenuOpen(false);
        requestMove({ sessionId, sections });
      }}
    >
      {t("menu.moveToSection")}
    </MenuItemButton>
  );
}

export interface ThreadSectionMoveInjected {
  hooks: { threadSectionMove: HostObservable<ThreadSectionMoveRequest | null> };
  dismiss: () => void;
  move: (sessionId: SessionId, sectionId: string | null) => Promise<void>;
}

type MoveProps = PropsLocale<"workspace"> & InjectFace<ThreadSectionMoveInjected>;

export function MoveThreadSectionDialog({ useThreadSectionMove, ...props }: MoveProps) {
  const request = useThreadSectionMove((value) => value);
  return request ? <MoveSectionForm key={request.sessionId} request={request} {...props} /> : null;
}

function MoveSectionForm({
  request,
  dismiss,
  move,
  t,
}: Omit<MoveProps, "useThreadSectionMove"> & { request: ThreadSectionMoveRequest }) {
  const current =
    request.sections.find((section) => section.threadIds.includes(request.sessionId))?.id ?? "";
  const [target, setTarget] = useState(current);
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const close = () => {
    if (!pending.current) dismiss();
  };
  const submit = async () => {
    if (pending.current || target === current) return;
    pending.current = true;
    setMoving(true);
    setFailed(false);
    try {
      await move(request.sessionId, target || null);
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
          <Button
            variant="primary"
            disabled={moving || target === current}
            onClick={() => void submit()}
          >
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
        onChange={({ target }) => setTarget(target.value)}
      >
        <option value="">{t("section.unsectioned")}</option>
        {request.sections.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {failed && (
        <div className={css.renameError} role="alert">
          {t("section.moveFailed")}
        </div>
      )}
    </Modal>
  );
}
