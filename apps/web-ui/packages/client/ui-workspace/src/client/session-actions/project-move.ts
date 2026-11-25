/**
 * Pure interaction logic for moving a local native Session to an existing local native project.
 *
 * Kept framework-free so eligibility, live dialog reconciliation, target-deletion handling,
 * and per-session in-flight locking can be verified directly by focused logic tests.
 */
import type {
  WorkspaceLocalProject,
  WorkspaceMoveSessionToProjectValue,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { SessionMoveLock } from "../session-move-lock.ts";
import type { SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceSnapshot } from "@deepseek-ai/dsh-api-workspace-controller/client";

/** Narrow authoritative move request dispatched to `workspace/moveSessionToProject`. */
export interface ProjectMovePayload {
  readonly sessionId: SessionId;
  readonly projectId: string;
}

export type ProjectMoveOutcome =
  | { readonly status: "committed"; readonly projectId: string }
  | { readonly status: "unknown" }
  | { readonly status: "skipped-in-flight" }
  | { readonly status: "failed"; readonly error: unknown };

export interface ProjectMoveCoordinator {
  /** All sessions with a shared placement lock, not only project moves. */
  readonly movingSessionIds: HostObservable<ReadonlySet<SessionId>>;
  /** True while any placement operation owns this session. */
  isMoving(sessionId: SessionId): boolean;
  /**
   * Commit one project move under a per-session in-flight lock.
   * Never mutates local snapshots optimistically; authoritative stream updates own placement.
   */
  move(
    payload: ProjectMovePayload,
    options?: { readonly notifyOnError?: boolean },
  ): Promise<ProjectMoveOutcome>;
}

export interface MoveProjectDialogState {
  readonly eligible: boolean;
  readonly availableProjects: readonly WorkspaceLocalProject[];
  readonly currentProjectId: string;
  /** Effective `<select>` value: live current project (or `""` if unassigned) before user choice, then user choice. */
  readonly effectiveTarget: string;
  /** True when the user explicitly selected a local project that no longer exists in the live list. */
  readonly targetDeleted: boolean;
  readonly canSubmit: boolean;
}

/** True when a local project descriptor carries a valid canonical native project ID. */
export function isValidLocalProject(
  project: WorkspaceLocalProject | null | undefined,
): project is WorkspaceLocalProject {
  return project != null && project.id !== "" && project.id.trim() === project.id;
}

/** Resolve a native source ID, explicit projectless (null), or missing/conflicting authority. */
export function resolveSessionProjectId(
  sessionId: SessionId,
  projects: readonly WorkspaceLocalProject[],
  projectlessSessionIds: readonly SessionId[] | undefined,
): string | null | undefined {
  let owner: WorkspaceLocalProject | null | undefined = projectlessSessionIds?.includes(sessionId)
    ? null
    : undefined;
  for (const project of projects) {
    if (!project.sessionIds.includes(sessionId)) continue;
    if (owner !== undefined || !isValidLocalProject(project)) return undefined;
    owner = project;
  }
  if (owner == null) return owner;
  const ownerId = owner.id;
  return projects.some((project) => project !== owner && project.id === ownerId)
    ? undefined
    : ownerId;
}

/**
 * Derive live options, current ownership, and submission validity for the move-to-project dialog.
 * Before the user makes a selection (`selectedTarget === null`), tracks the session's live
 * ownership and keeps submission disabled. Once the user picks a destination project, preserves
 * that choice; if the selected project disappears while open, keeps the selection intact (without
 * auto-switching) and blocks submission until another existing local project is chosen.
 */
export function resolveMoveProjectDialogState(input: {
  readonly sessionId: SessionId;
  readonly workspace: Pick<
    WorkspaceSnapshot,
    | "state"
    | "phase"
    | "localProjects"
    | "projectlessSessionIds"
    | "pinnedSessionIds"
    | "archivedSessionIds"
  >;
  readonly summary:
    Pick<SessionSummary, "id" | "blank" | "origin" | "parentId" | "projectionValues"> | undefined;
  /** `null` before user selection; chosen native `projectId` otherwise. */
  readonly selectedTarget: string | null;
  readonly busy: boolean;
}): MoveProjectDialogState {
  const { workspace, sessionId, summary } = input;
  const projects = workspace.localProjects ?? [];
  const unique = new Set<string>();
  const duplicate = new Set<string>();
  for (const { id } of projects) {
    if (unique.has(id)) duplicate.add(id);
    unique.add(id);
  }
  const availableProjects = projects.filter(
    (project) => isValidLocalProject(project) && !duplicate.has(project.id),
  );
  const source = resolveSessionProjectId(sessionId, projects, workspace.projectlessSessionIds);
  const currentProjectId = source ?? "";
  const reference = summary?.projectionValues?.threadReference;
  const eligible =
    workspace.phase === "ready" &&
    workspace.state === "idle" &&
    summary?.id === sessionId &&
    !sessionId.startsWith("web-remote:") &&
    !summary.blank &&
    summary.origin !== "subagent" &&
    summary.parentId === undefined &&
    summary.projectionValues?.nativeDiscovery === true &&
    !summary.projectionValues?.remoteHost &&
    summary.projectionValues?.threadTreeParent === null &&
    reference?.hostId === "local" &&
    (reference.threadId === undefined || reference.threadId === sessionId) &&
    !workspace.pinnedSessionIds.includes(sessionId) &&
    !workspace.archivedSessionIds.includes(sessionId) &&
    source !== undefined &&
    availableProjects.some(({ id }) => id !== source);
  const effectiveTarget = input.selectedTarget ?? currentProjectId;
  const targetDeleted =
    input.selectedTarget !== null &&
    input.selectedTarget !== "" &&
    !availableProjects.some((project) => project.id === input.selectedTarget);
  const canSubmit =
    eligible &&
    !input.busy &&
    input.selectedTarget !== null &&
    input.selectedTarget !== "" &&
    !targetDeleted &&
    input.selectedTarget !== currentProjectId;
  return {
    eligible,
    availableProjects,
    currentProjectId,
    effectiveTarget,
    targetDeleted,
    canSubmit,
  };
}

/**
 * Create a per-session in-flight lock coordinator for project moves.
 * Concurrent moves for different sessions proceed independently; duplicate moves for
 * the same session are skipped until the in-flight request settles.
 */
export function createProjectMoveCoordinator(options: {
  readonly lock: SessionMoveLock;
  readonly execute: (
    sessionId: SessionId,
    projectId: string,
  ) => Promise<WorkspaceMoveSessionToProjectValue>;
  readonly onError?: (error: unknown) => void;
}): ProjectMoveCoordinator {
  const { lock } = options;
  return {
    movingSessionIds: lock.movingSessionIds,
    isMoving: lock.isMoving,
    async move(payload, moveOptions = {}) {
      if (!lock.tryAcquire(payload.sessionId)) {
        return { status: "skipped-in-flight" };
      }
      try {
        const result = await options.execute(payload.sessionId, payload.projectId);
        if (result.status !== "confirmed") {
          return { status: "unknown" };
        }
        return { status: "committed", projectId: result.projectId };
      } catch (error) {
        if (moveOptions.notifyOnError !== false) options.onError?.(error);
        return { status: "failed", error };
      } finally {
        lock.release(payload.sessionId);
      }
    },
  };
}
