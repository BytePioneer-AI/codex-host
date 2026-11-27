import { useRef, useState } from "react";
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconFolderCloseRegular,
  MenuItemButton,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import type { ArchivedFilter } from "../tree.ts";
import {
  findSessionCustomSection,
  isManageableCustomSection,
  resolveMoveSectionDialogState,
  resolveSectionStepMove,
  visibleCustomSectionThreadIds,
  type SectionMoveOutcome,
  type SectionMovePayload,
} from "../rows/section-dnd.ts";
import css from "../rows/WorkspaceBrowser.module.css";

export interface ThreadSectionMoveRequest {
  sessionId: SessionId;
}

export interface ThreadSectionMenuInjected {
  hooks: {
    nativeThreads: HostObservable<ReadonlySet<SessionId>>;
    sectionWorkspace: HostObservable<WorkspaceSnapshot>;
    sectionSessions: HostObservable<SessionListState>;
    scopedSessionIds: HostObservable<ReadonlySet<SessionId> | null>;
    archivedFilter: HostObservable<ArchivedFilter>;
    movingSectionSessions: HostObservable<ReadonlySet<SessionId>>;
  };
  requestMove: (request: ThreadSectionMoveRequest) => void;
  moveSession: (payload: SectionMovePayload) => Promise<SectionMoveOutcome>;
}

function useSectionMenuContext(props: SessionMenuItemProps<ThreadSectionMenuInjected>) {
  const {
    sessionId,
    useNativeThreads,
    useSectionWorkspace,
    useSectionSessions,
    useScopedSessionIds,
    useArchivedFilter,
    useMovingSectionSessions,
  } = props;
  const nativeThread = useNativeThreads((threads) => threads.has(sessionId));
  const workspace = useSectionWorkspace((snapshot) => snapshot);
  const sessions = useSectionSessions((snapshot) => snapshot);
  const harnessId = sessions.byId[sessionId]?.projectionValues?.harnessIdentity?.id;
  const preciseMoves = workspace.threadSectionsV1 === true;
  const scopedSessionIds = useScopedSessionIds((ids) => ids);
  const archivedFilter = useArchivedFilter((filter) => filter);
  const moving = useMovingSectionSessions((ids) => ids.has(sessionId));
  const manageableSections = (workspace.threadSections ?? []).filter(isManageableCustomSection);
  const eligible =
    nativeThread &&
    (harnessId === "codex" || preciseMoves) &&
    manageableSections.length > 0 &&
    !workspace.pinnedSessionIds.includes(sessionId) &&
    !workspace.archivedSessionIds.includes(sessionId);
  const currentSection = eligible
    ? findSessionCustomSection(sessionId, manageableSections)
    : undefined;
  const visibleIds =
    currentSection === undefined
      ? []
      : visibleCustomSectionThreadIds(currentSection, {
          byId: sessions.byId,
          pinnedSessionIds: workspace.pinnedSessionIds,
          archivedSessionIds: workspace.archivedSessionIds,
          archivedFilter,
          visibleSessionIds: scopedSessionIds ?? new Set(sessions.ids),
        });
  return { eligible, currentSection, visibleIds, moving, preciseMoves };
}

export function MoveThreadSectionMenuItem(props: SessionMenuItemProps<ThreadSectionMenuInjected>) {
  const { sessionId, useMenuOpenState, requestMove, t } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const { eligible, moving } = useSectionMenuContext(props);
  if (!eligible) return null;
  return (
    <MenuItemButton
      icon={<IconFolderCloseRegular />}
      disabled={moving}
      onSelect={() => {
        if (moving) return;
        setMenuOpen(false);
        requestMove({ sessionId });
      }}
    >
      {t("menu.moveToSection")}
    </MenuItemButton>
  );
}

export function RemoveFromThreadSectionMenuItem(
  props: SessionMenuItemProps<ThreadSectionMenuInjected>,
) {
  const { sessionId, useMenuOpenState, moveSession, t } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const { eligible, currentSection, moving } = useSectionMenuContext(props);
  if (!eligible || currentSection === undefined) return null;
  return (
    <MenuItemButton
      icon={<IconFolderCloseRegular />}
      disabled={moving}
      onSelect={() => {
        if (moving) return;
        setMenuOpen(false);
        void moveSession({ sessionId, sectionId: null });
      }}
    >
      {t("menu.removeFromSection")}
    </MenuItemButton>
  );
}

export function MoveThreadSectionUpMenuItem(
  props: SessionMenuItemProps<ThreadSectionMenuInjected>,
) {
  const { sessionId, useMenuOpenState, moveSession, t } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const { eligible, currentSection, visibleIds, moving, preciseMoves } =
    useSectionMenuContext(props);
  if (!eligible || !preciseMoves || currentSection === undefined) return null;
  const stepMove = resolveSectionStepMove(sessionId, "up", currentSection, visibleIds);
  const disabled = moving || stepMove === null;
  return (
    <MenuItemButton
      icon={<IconChevronUpOutlineRegular />}
      disabled={disabled}
      onSelect={() => {
        if (disabled || stepMove === null) return;
        setMenuOpen(false);
        void moveSession(stepMove);
      }}
    >
      {t("menu.moveSectionUp")}
    </MenuItemButton>
  );
}

export function MoveThreadSectionDownMenuItem(
  props: SessionMenuItemProps<ThreadSectionMenuInjected>,
) {
  const { sessionId, useMenuOpenState, moveSession, t } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const { eligible, currentSection, visibleIds, moving, preciseMoves } =
    useSectionMenuContext(props);
  if (!eligible || !preciseMoves || currentSection === undefined) return null;
  const stepMove = resolveSectionStepMove(sessionId, "down", currentSection, visibleIds);
  const disabled = moving || stepMove === null;
  return (
    <MenuItemButton
      icon={<IconChevronDownOutlineRegular />}
      disabled={disabled}
      onSelect={() => {
        if (disabled || stepMove === null) return;
        setMenuOpen(false);
        void moveSession(stepMove);
      }}
    >
      {t("menu.moveSectionDown")}
    </MenuItemButton>
  );
}

export interface ThreadSectionMoveInjected {
  hooks: {
    threadSectionMove: HostObservable<ThreadSectionMoveRequest | null>;
    sectionWorkspace: HostObservable<WorkspaceSnapshot>;
    movingSectionSessions: HostObservable<ReadonlySet<SessionId>>;
  };
  dismiss: () => void;
  move: (payload: SectionMovePayload) => Promise<SectionMoveOutcome>;
}

type MoveProps = PropsLocale<"workspace"> & InjectFace<ThreadSectionMoveInjected>;

export function MoveThreadSectionDialog({ useThreadSectionMove, ...props }: MoveProps) {
  const request = useThreadSectionMove((value) => value);
  return request ? <MoveSectionForm key={request.sessionId} request={request} {...props} /> : null;
}

function MoveSectionForm({
  request,
  useSectionWorkspace,
  useMovingSectionSessions,
  dismiss,
  move,
  t,
}: Omit<MoveProps, "useThreadSectionMove"> & { request: ThreadSectionMoveRequest }) {
  const liveSections = useSectionWorkspace((snapshot) => snapshot.threadSections);
  const inFlight = useMovingSectionSessions((ids) => ids.has(request.sessionId));
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const busy = moving || inFlight;
  const { manageableSections, effectiveTarget, targetDeleted, canSubmit } =
    resolveMoveSectionDialogState({
      sessionId: request.sessionId,
      sections: liveSections,
      selectedTarget,
      busy,
    });
  const close = () => {
    if (!pending.current && !inFlight) dismiss();
  };
  const submit = async () => {
    if (pending.current || !canSubmit || selectedTarget === null) return;
    pending.current = true;
    setMoving(true);
    setFailed(false);
    try {
      const outcome = await move({
        sessionId: request.sessionId,
        sectionId: selectedTarget || null,
      });
      if (outcome.status === "committed") dismiss();
      else if (outcome.status === "failed") setFailed(true);
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
          <Button variant="outline" disabled={busy} onClick={close}>
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
        disabled={busy}
        data-modal-autofocus
        onChange={({ target: select }) => {
          setSelectedTarget(select.value);
          setFailed(false);
        }}
      >
        {targetDeleted && (
          <option value={effectiveTarget} disabled>
            {t("section.targetDeletedOption")}
          </option>
        )}
        <option value="">{t("section.unsectioned")}</option>
        {manageableSections.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
      {targetDeleted && (
        <div className={css.renameError} role="alert">
          {t("section.targetDeleted")}
        </div>
      )}
      {failed && !targetDeleted && (
        <div className={css.renameError} role="alert">
          {t("section.moveFailed")}
        </div>
      )}
    </Modal>
  );
}
