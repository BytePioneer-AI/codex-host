import { type DragEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceId, WorkspaceView } from "@deepseek-ai/dsh-api-workspace-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ProjectDragSnapshot, WorkspaceBrowserProps } from "../contract/slots.ts";
import {
  buildWorkspaceLocalProjectMap,
  resolveProjectDragSource,
  resolveProjectDropMove,
  resolveProjectDropTarget,
  type ProjectDragInput,
  type ProjectDragSource,
  type ProjectDropTarget,
} from "./project-dnd.ts";

export interface ProjectDropHandlers {
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

type Gesture = {
  source: ProjectDragSource;
  element: HTMLElement;
  over: (ProjectDropTarget & { rowId: SessionId | undefined; element: HTMLElement }) | null;
};

/** Only the header and actual session rows receive target handlers, never their enclosing group. */
export function useProjectDrag({
  enabled,
  workspaces,
  rendered,
  getProjectDragSnapshot,
  isSessionMoving,
  moveSessionToProject,
  clearOtherHover,
  endOtherDrag,
}: Pick<WorkspaceBrowserProps, "getProjectDragSnapshot" | "isSessionMoving"> & {
  rendered: ProjectDragSnapshot;
  moveSessionToProject: WorkspaceBrowserProps["moveSessionToProject"];
  enabled: boolean;
  workspaces: readonly WorkspaceView[];
  clearOtherHover: () => void;
  endOtherDrag: () => void;
}) {
  const [gesture, render] = useState<Gesture | null>(null);
  const active = useRef<Gesture | null>(null);
  const set = (next: Gesture | null) => {
    active.current = next;
    render(next);
  };
  const end = () => set(null);
  const clearHover = () => {
    const current = active.current;
    if (current?.over) set({ ...current, over: null });
  };

  const input = useMemo(() => {
    const scoped = new Set(workspaces.filter((w) => !w.remote).map((w) => w.workspaceId));
    let cache:
      | { workspace: ProjectDragSnapshot["workspace"]; owners: ReadonlyMap<WorkspaceId, string> }
      | undefined;
    return (
      snapshot: ProjectDragSnapshot,
      sessionId: SessionId,
      sourceWorkspaceId: WorkspaceId | null,
    ): ProjectDragInput | null => {
      const { workspace, sessions } = snapshot;
      if (!enabled || !moveSessionToProject || sessions.phase !== "ready") return null;
      if (cache?.workspace !== workspace) {
        const all = buildWorkspaceLocalProjectMap(workspace.localProjects);
        const visible = new Map<WorkspaceId, string>();
        for (const item of workspace.items) {
          const id = all.get(item.workspaceId);
          if (id !== undefined && !item.remote && scoped.has(item.workspaceId)) {
            visible.set(item.workspaceId, id);
          }
        }
        cache = { workspace, owners: visible };
      }
      if (workspace.threadSections?.some(({ threadIds }) => threadIds.includes(sessionId))) {
        return null;
      }
      if (
        sourceWorkspaceId === null
          ? !sessions.ids.includes(sessionId)
          : !workspace.items.some(
              (item) =>
                item.workspaceId === sourceWorkspaceId && item.sessionIds.includes(sessionId),
            )
      ) {
        return null;
      }
      return {
        sessionId,
        workspace,
        summary: sessions.byId[sessionId],
        busy: isSessionMoving(sessionId),
        sourceKind: sourceWorkspaceId === null ? "recents" : "project",
        sourceWorkspaceId,
        workspaceProjectMap: cache.owners,
      };
    };
  }, [enabled, isSessionMoving, moveSessionToProject, workspaces]);

  const getSource = (
    snapshot: ProjectDragSnapshot,
    id: SessionId,
    workspaceId: WorkspaceId | null,
  ) => {
    const live = input(snapshot, id, workspaceId);
    return live && resolveProjectDragSource(live);
  };
  const readTarget = (
    snapshot: ProjectDragSnapshot,
    { source, element }: Gesture,
    targetWorkspaceId: WorkspaceId,
    rowId: SessionId | undefined,
  ) => {
    if (!element.isConnected) return null;
    const live = input(snapshot, source.sessionId, source.sourceWorkspaceId);
    if (!live) return null;
    return {
      live,
      source,
      targetWorkspaceId,
      targetRow: rowId === undefined ? undefined : input(snapshot, rowId, targetWorkspaceId),
    };
  };
  const isCurrentHover = (snapshot: ProjectDragSnapshot, current: Gesture) => {
    const { over } = current;
    if (!over?.element.isConnected) return false;
    const live = readTarget(snapshot, current, over.workspaceId, over.rowId);
    return live !== null && resolveProjectDropTarget(live)?.projectId === over.projectId;
  };

  useLayoutEffect(() => {
    if (!gesture || gesture !== active.current) return;
    const { source, element, over } = gesture;
    const live = input(rendered, source.sessionId, source.sourceWorkspaceId);
    if (
      !element.isConnected ||
      !live ||
      resolveProjectDragSource(live)?.sourceProjectId !== source.sourceProjectId
    ) {
      end();
    } else if (over && live.workspaceProjectMap.get(over.workspaceId) !== over.projectId) {
      // A changed owner must not turn an old marker into consent to move elsewhere.
      end();
    } else if (over && !isCurrentHover(rendered, gesture)) {
      clearHover();
    }
  });

  const start = (id: SessionId, workspaceId: WorkspaceId | null, element: HTMLElement) => {
    const source = getSource(getProjectDragSnapshot(), id, workspaceId);
    set(source ? { source, element, over: null } : null);
  };
  const target = (
    targetWorkspaceId: WorkspaceId,
    rowId?: SessionId,
  ): ProjectDropHandlers | undefined => {
    if (gesture === null || gesture.source.sourceWorkspaceId === targetWorkspaceId)
      return undefined;
    return {
      onDragOver(event) {
        const current = active.current;
        if (!current) return;
        const live = readTarget(getProjectDragSnapshot(), current, targetWorkspaceId, rowId);
        const over = live && resolveProjectDropTarget(live);
        if (!over) {
          clearHover();
          return;
        }
        const previous = current.over;
        if (
          previous &&
          over.workspaceId === previous.workspaceId &&
          over.projectId !== previous.projectId
        ) {
          end();
          endOtherDrag();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (
          !previous ||
          over.workspaceId !== previous.workspaceId ||
          rowId !== previous.rowId ||
          event.currentTarget !== previous.element
        ) {
          clearOtherHover();
          set({ ...current, over: { ...over, rowId, element: event.currentTarget } });
        }
      },
      onDrop(event) {
        const current = active.current;
        const snapshot = getProjectDragSnapshot();
        if (!current || !moveSessionToProject || !isCurrentHover(snapshot, current)) {
          clearHover();
          return;
        }
        const live = readTarget(snapshot, current, targetWorkspaceId, rowId);
        if (!live) return;
        const payload = resolveProjectDropMove({
          ...live,
          expectedTarget: current.over,
          dropEffect: event.dataTransfer.dropEffect,
        });
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        end();
        endOtherDrag();
        void moveSessionToProject(payload);
      },
    };
  };
  return {
    active: gesture !== null,
    over: gesture?.over,
    canStart: (id: SessionId, workspaceId: WorkspaceId | null) =>
      getSource(rendered, id, workspaceId) !== null,
    start,
    target,
    clearHover,
    end,
  };
}
