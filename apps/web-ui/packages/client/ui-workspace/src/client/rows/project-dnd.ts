import type {
  WorkspaceId,
  WorkspaceLocalProject,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  isValidLocalProject,
  resolveMoveProjectDialogState,
  type ProjectMovePayload,
} from "../session-actions/project-move.ts";

export interface ProjectDragSource {
  readonly sessionId: SessionId;
  readonly sourceWorkspaceId: WorkspaceId | null;
  readonly sourceProjectId: string | null;
  readonly sourceKind: "project" | "recents";
}

export interface ProjectDropTarget {
  readonly workspaceId: WorkspaceId;
  readonly projectId: string;
}

type DialogInput = Parameters<typeof resolveMoveProjectDialogState>[0];

export interface ProjectDragInput extends Omit<DialogInput, "selectedTarget"> {
  readonly sourceKind: ProjectDragSource["sourceKind"];
  readonly sourceWorkspaceId: WorkspaceId | null;
  /** Unique project owners for the currently rendered local workspace groups. */
  readonly workspaceProjectMap: ReadonlyMap<WorkspaceId, string>;
}

/** Shared roots and duplicate project descriptors do not identify a destination. */
export function buildWorkspaceLocalProjectMap(
  projects: readonly WorkspaceLocalProject[] | undefined,
): ReadonlyMap<WorkspaceId, string> {
  const owners = new Map<WorkspaceId, string>();
  const ambiguous = new Set<WorkspaceId>();
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const project of projects ?? []) {
    if (ids.has(project.id)) duplicates.add(project.id);
    ids.add(project.id);
    for (const root of project.workspaceIds ?? []) {
      if (!root) continue;
      const owner = owners.get(root);
      if (!isValidLocalProject(project) || (owner !== undefined && owner !== project.id)) {
        ambiguous.add(root);
      } else {
        owners.set(root, project.id);
      }
    }
  }
  for (const [root, id] of owners) {
    if (ambiguous.has(root) || duplicates.has(id)) owners.delete(root);
  }
  return owners;
}

export function isProjectDropTargetRow(live: ProjectDragInput): boolean {
  if (live.busy || live.sourceKind !== "project" || live.sourceWorkspaceId === null) return false;
  const state = resolveMoveProjectDialogState({ ...live, selectedTarget: null });
  return (
    state.rowEligible &&
    live.workspaceProjectMap.get(live.sourceWorkspaceId) === state.currentProjectId
  );
}

export function resolveProjectDragSource(live: ProjectDragInput): ProjectDragSource | null {
  const { sourceKind, sourceWorkspaceId, sessionId, workspaceProjectMap } = live;
  if (live.busy) return null;
  const state = resolveMoveProjectDialogState({ ...live, selectedTarget: null });
  if (!state.eligible) return null;
  const sourceProjectId = state.currentProjectId || null;
  if (
    sourceKind === "recents"
      ? sourceWorkspaceId !== null
      : sourceWorkspaceId === null || workspaceProjectMap.get(sourceWorkspaceId) !== sourceProjectId
  ) {
    return null;
  }
  for (const id of workspaceProjectMap.values()) {
    if (id !== sourceProjectId && state.availableProjects.some((project) => project.id === id)) {
      return { sourceKind, sourceWorkspaceId, sourceProjectId, sessionId };
    }
  }
  return null;
}

interface ProjectDropInput {
  readonly source: ProjectDragSource;
  readonly live: ProjectDragInput;
  readonly targetWorkspaceId: WorkspaceId | undefined;
  /** Undefined for a header; null when the hovered row is no longer available. */
  readonly targetRow?: ProjectDragInput | null;
}

export function resolveProjectDropTarget(input: ProjectDropInput): ProjectDropTarget | null {
  const { live, source, targetWorkspaceId, targetRow } = input;
  if (
    targetWorkspaceId === undefined ||
    (targetRow !== undefined &&
      (targetRow === null ||
        targetRow.sourceWorkspaceId !== targetWorkspaceId ||
        !isProjectDropTargetRow(targetRow))) ||
    live.sessionId !== source.sessionId ||
    live.sourceKind !== source.sourceKind ||
    live.sourceWorkspaceId !== source.sourceWorkspaceId ||
    (source.sourceWorkspaceId !== null &&
      live.workspaceProjectMap.get(source.sourceWorkspaceId) !== source.sourceProjectId)
  )
    return null;
  const projectId = live.workspaceProjectMap.get(targetWorkspaceId);
  if (projectId === undefined) return null;
  const state = resolveMoveProjectDialogState({ ...live, selectedTarget: projectId });
  if (!state.canSubmit || (state.currentProjectId || null) !== source.sourceProjectId) return null;
  return { workspaceId: targetWorkspaceId, projectId };
}

export function resolveProjectDropMove(
  input: ProjectDropInput & {
    readonly expectedTarget: ProjectDropTarget | null;
    readonly dropEffect?: string | null;
  },
): ProjectMovePayload | null {
  if (input.dropEffect === "copy" || !input.expectedTarget) {
    return null;
  }
  const target = resolveProjectDropTarget(input);
  if (
    !target ||
    target.workspaceId !== input.expectedTarget.workspaceId ||
    target.projectId !== input.expectedTarget.projectId
  )
    return null;
  return { sessionId: input.source.sessionId, projectId: target.projectId };
}
