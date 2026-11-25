import { useRef, useState } from "react";
import {
  Button,
  IconFolderOpenOutlineRegular,
  MenuItemButton,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { HostObservable, InjectFace, PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMenuItemProps } from "../contract/slots.ts";
import {
  isProjectMovableSession,
  resolveMoveProjectDialogState,
  type ProjectMoveOutcome,
  type ProjectMovePayload,
} from "./project-move.ts";
import css from "../rows/WorkspaceBrowser.module.css";

export interface ThreadProjectMoveRequest {
  sessionId: SessionId;
}

export interface ThreadProjectMenuInjected {
  hooks: {
    nativeThreads: HostObservable<ReadonlySet<SessionId>>;
    projectWorkspace: HostObservable<WorkspaceSnapshot>;
    projectSessions: HostObservable<SessionListState>;
    movingProjectSessions: HostObservable<ReadonlySet<SessionId>>;
  };
  canMove: boolean;
  requestMove: (request: ThreadProjectMoveRequest) => void;
}

export function MoveThreadProjectMenuItem(props: SessionMenuItemProps<ThreadProjectMenuInjected>) {
  const {
    sessionId,
    threadTreeChild,
    useMenuOpenState,
    useNativeThreads,
    useProjectWorkspace,
    useProjectSessions,
    useMovingProjectSessions,
    canMove,
    requestMove,
    t,
  } = props;
  const [, setMenuOpen] = useMenuOpenState();
  const nativeThreadIds = useNativeThreads((threads) => threads);
  const workspace = useProjectWorkspace((snapshot) => snapshot);
  const summary = useProjectSessions((snapshot) => snapshot.byId[sessionId]);
  const moving = useMovingProjectSessions((ids) => ids.has(sessionId));
  const eligible = isProjectMovableSession({
    sessionId,
    canMoveProject: canMove,
    nativeThreadIds,
    archivedSessionIds: workspace.archivedSessionIds,
    localProjects: workspace.localProjects,
    blank: summary?.blank,
    subagent: summary?.origin === "subagent",
    threadTreeChild,
    threadTreeParent: summary?.projectionValues?.threadTreeParent,
    remote: Boolean(summary?.projectionValues?.remoteHost),
  });
  if (!eligible) return null;
  return (
    <MenuItemButton
      icon={<IconFolderOpenOutlineRegular />}
      disabled={moving}
      onSelect={() => {
        if (moving) return;
        setMenuOpen(false);
        requestMove({ sessionId });
      }}
    >
      {t("menu.moveToProject")}
    </MenuItemButton>
  );
}

export interface ThreadProjectMoveInjected {
  hooks: {
    threadProjectMove: HostObservable<ThreadProjectMoveRequest | null>;
    projectWorkspace: HostObservable<WorkspaceSnapshot>;
    movingProjectSessions: HostObservable<ReadonlySet<SessionId>>;
  };
  dismiss: () => void;
  move: (payload: ProjectMovePayload) => Promise<ProjectMoveOutcome>;
}

type MoveProps = PropsLocale<"workspace"> & InjectFace<ThreadProjectMoveInjected>;

export function MoveThreadProjectDialog({ useThreadProjectMove, ...props }: MoveProps) {
  const request = useThreadProjectMove((value) => value);
  return request ? <MoveProjectForm key={request.sessionId} request={request} {...props} /> : null;
}

function MoveProjectForm({
  request,
  useProjectWorkspace,
  useMovingProjectSessions,
  dismiss,
  move,
  t,
}: Omit<MoveProps, "useThreadProjectMove"> & { request: ThreadProjectMoveRequest }) {
  const liveProjects = useProjectWorkspace((snapshot) => snapshot.localProjects);
  const inFlight = useMovingProjectSessions((ids) => ids.has(request.sessionId));
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [errorKind, setErrorKind] = useState<"failed" | "unknown" | null>(null);
  const pending = useRef(false);
  const busy = moving || inFlight;
  const { availableProjects, effectiveTarget, targetDeleted, canSubmit } =
    resolveMoveProjectDialogState({
      sessionId: request.sessionId,
      projects: liveProjects,
      selectedTarget,
      busy,
    });
  const close = () => {
    if (!pending.current && !inFlight) dismiss();
  };
  const submit = async () => {
    if (pending.current || !canSubmit || selectedTarget === null || selectedTarget === "") return;
    pending.current = true;
    setMoving(true);
    setErrorKind(null);
    try {
      const outcome = await move({
        sessionId: request.sessionId,
        projectId: selectedTarget,
      });
      if (outcome.status === "committed") dismiss();
      else if (outcome.status === "unknown") setErrorKind("unknown");
      else if (outcome.status === "failed") setErrorKind("failed");
    } finally {
      pending.current = false;
      setMoving(false);
    }
  };
  return (
    <Modal
      phoneSidebar
      open
      title={t("menu.moveToProject")}
      closeLabel={t("close")}
      onClose={close}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close}>
            {t("cancel")}
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t("project.moving") : t("project.move")}
          </Button>
        </>
      }
    >
      <select
        className={css.renameInput}
        aria-label={t("project.destination")}
        value={effectiveTarget}
        disabled={busy}
        data-modal-autofocus
        onChange={({ target: select }) => {
          setSelectedTarget(select.value);
          setErrorKind(null);
        }}
      >
        {targetDeleted && (
          <option value={effectiveTarget} disabled>
            {t("project.targetDeletedOption")}
          </option>
        )}
        {!targetDeleted && effectiveTarget === "" && (
          <option value="" disabled>
            {t("project.selectPlaceholder")}
          </option>
        )}
        {availableProjects.map(({ id, name }) => (
          <option key={id} value={id}>
            {name || id}
          </option>
        ))}
      </select>
      {busy && (
        <div className={css.deleteStatus} role="status">
          {t("project.moving")}
        </div>
      )}
      {targetDeleted && (
        <div className={css.renameError} role="alert">
          {t("project.targetDeleted")}
        </div>
      )}
      {errorKind !== null && !targetDeleted && (
        <div className={css.renameError} role="alert">
          {errorKind === "unknown" ? t("project.outcomeUnknown") : t("project.moveFailed")}
        </div>
      )}
    </Modal>
  );
}
