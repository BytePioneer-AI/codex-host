import { IconFolderCloseRegular, MenuItemButton } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import { MoveSectionForm } from "../rows/MoveSectionForm.tsx";

export interface ThreadSectionMenuInjected {
  hooks: {
    nativeThreads: HostObservable<ReadonlySet<SessionId>>;
    sectionWorkspace: HostObservable<WorkspaceSnapshot>;
  };
  requestMove: (sessionId: SessionId) => void;
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
        requestMove(sessionId);
      }}
    >
      {t("menu.moveToSection")}
    </MenuItemButton>
  );
}

export interface ThreadSectionMoveInjected {
  hooks: {
    threadSectionMove: HostObservable<SessionId | null>;
    sectionWorkspace: HostObservable<WorkspaceSnapshot>;
  };
  dismiss: () => void;
  move: (sessionId: SessionId, sectionId: string | null) => Promise<void>;
}

type MoveProps = PropsLocale<"workspace"> & InjectFace<ThreadSectionMoveInjected>;

export function MoveThreadSectionDialog({
  useThreadSectionMove,
  useSectionWorkspace,
  dismiss,
  move,
  t,
}: MoveProps) {
  const sessionId = useThreadSectionMove((value) => value);
  const sections = useSectionWorkspace((workspace) => workspace.threadSections);
  if (!sessionId || !sections) return null;
  return (
    <MoveSectionForm
      key={sessionId}
      current={sections.find((section) => section.threadIds.includes(sessionId))?.id ?? ""}
      sections={sections}
      move={(target) => move(sessionId, target)}
      dismiss={dismiss}
      defaultLabel={t("section.unsectioned")}
      failedLabel={t("section.moveFailed")}
      t={t}
    />
  );
}
