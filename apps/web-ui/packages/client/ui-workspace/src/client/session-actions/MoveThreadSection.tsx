import { useState } from "react";
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconFolderCloseRegular,
  MenuItemButton,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { shallowEqual } from "@deepseek-ai/dsh-client-store";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import type { ArchivedFilter } from "../tree.ts";
import {
  findSessionCustomSection,
  isManageableCustomSection,
  resolveSectionStepMove,
  visibleCustomSectionThreadIds,
  type SectionMoveOutcome,
  type SectionMovePayload,
} from "../rows/section-dnd.ts";
import { MoveSectionForm } from "../rows/MoveSectionForm.tsx";

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
    useMovingSectionSessions,
  } = props;
  const nativeThread = useNativeThreads((threads) => threads.has(sessionId));
  const codex = useSectionSessions(
    (snapshot) => snapshot.byId[sessionId]?.projectionValues?.harnessIdentity?.id === "codex",
  );
  const preciseMoves = useSectionWorkspace((snapshot) => snapshot.threadSectionsV1 === true);
  const available = useSectionWorkspace(
    (snapshot) =>
      (snapshot.threadSections?.some(isManageableCustomSection) ?? false) &&
      !snapshot.pinnedSessionIds.includes(sessionId) &&
      !snapshot.archivedSessionIds.includes(sessionId),
  );
  const moving = useMovingSectionSessions((ids) => ids.has(sessionId));
  return { eligible: nativeThread && (codex || preciseMoves) && available, moving, preciseMoves };
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
  const { eligible, moving } = useSectionMenuContext(props);
  const sectionId = props.useSectionWorkspace(
    (snapshot) => findSessionCustomSection(sessionId, snapshot.threadSections)?.id,
  );
  if (!eligible || sectionId === undefined) return null;
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
  return <MoveThreadSectionStepMenuItem {...props} direction="up" />;
}

export function MoveThreadSectionDownMenuItem(
  props: SessionMenuItemProps<ThreadSectionMenuInjected>,
) {
  return <MoveThreadSectionStepMenuItem {...props} direction="down" />;
}

function MoveThreadSectionStepMenuItem({
  direction,
  ...props
}: SessionMenuItemProps<ThreadSectionMenuInjected> & { direction: "up" | "down" }) {
  const { sessionId, useMenuOpenState, moveSession, t } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const { eligible, moving, preciseMoves } = useSectionMenuContext(props);
  const currentSection = props.useSectionWorkspace((snapshot) =>
    findSessionCustomSection(sessionId, snapshot.threadSections),
  );
  const pinnedSessionIds = props.useSectionWorkspace((snapshot) => snapshot.pinnedSessionIds);
  const archivedSessionIds = props.useSectionWorkspace((snapshot) => snapshot.archivedSessionIds);
  const scopedSessionIds = props.useScopedSessionIds(
    (ids) => (ids && currentSection ? currentSection.threadIds.filter((id) => ids.has(id)) : null),
    shallowEqual,
  );
  const archivedFilter = props.useArchivedFilter((filter) => filter);
  const stepMove = props.useSectionSessions(
    (sessions) => {
      if (!eligible || !preciseMoves || !currentSection) return null;
      const visibleIds = visibleCustomSectionThreadIds(currentSection, {
        byId: sessions.byId,
        pinnedSessionIds,
        archivedSessionIds,
        archivedFilter,
        visibleSessionIds: new Set(scopedSessionIds ?? sessions.ids),
      });
      return resolveSectionStepMove(sessionId, direction, currentSection, visibleIds);
    },
    (a, b) => a?.sectionId === b?.sectionId && a?.beforeSessionId === b?.beforeSessionId,
  );
  if (!eligible || !preciseMoves || currentSection === undefined) return null;
  const disabled = moving || stepMove === null;
  return (
    <MenuItemButton
      icon={
        direction === "up" ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />
      }
      disabled={disabled}
      onSelect={() => {
        if (disabled || stepMove === null) return;
        setMenuOpen(false);
        void moveSession(stepMove);
      }}
    >
      {t(direction === "up" ? "menu.moveSectionUp" : "menu.moveSectionDown")}
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
  return request ? <MoveSessionForm key={request.sessionId} request={request} {...props} /> : null;
}

function MoveSessionForm({
  request,
  useSectionWorkspace,
  useMovingSectionSessions,
  dismiss,
  move,
  t,
}: Omit<MoveProps, "useThreadSectionMove"> & { request: ThreadSectionMoveRequest }) {
  const liveSections = useSectionWorkspace((snapshot) => snapshot.threadSections);
  const inFlight = useMovingSectionSessions((ids) => ids.has(request.sessionId));
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const sections = (liveSections ?? []).filter(isManageableCustomSection);
  const current = findSessionCustomSection(request.sessionId, sections)?.id ?? "";
  return (
    <MoveSectionForm
      current={current}
      sections={sections}
      dismiss={dismiss}
      busy={inFlight}
      disabled={outcomeUnknown}
      blockedMessage={outcomeUnknown ? t("section.outcomeUnknown") : undefined}
      defaultLabel={t("section.unsectioned")}
      failedLabel={t("section.moveFailed")}
      deletedTargetLabel={t("section.targetDeleted")}
      move={async (sectionId) => {
        const outcome = await move({ sessionId: request.sessionId, sectionId });
        switch (outcome.status) {
          case "committed":
            return;
          case "failed":
            throw outcome.error;
          case "unknown":
            setOutcomeUnknown(true);
            return false;
          case "skipped-in-flight":
            return false;
        }
      }}
      t={t}
    />
  );
}
