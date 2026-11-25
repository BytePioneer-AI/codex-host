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
  /** Observable snapshot of sessions that currently have a project move RPC in flight. */
  readonly movingSessionIds: HostObservable<ReadonlySet<SessionId>>;
  /** True while `sessionId` already has a project move request in flight. */
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

export interface ProjectSessionEligibilityInput {
  readonly sessionId: SessionId;
  readonly canMoveProject: boolean;
  readonly nativeThreadIds: ReadonlySet<SessionId>;
  readonly archivedSessionIds: readonly SessionId[];
  readonly localProjects: readonly WorkspaceLocalProject[] | undefined;
  readonly blank?: boolean;
  readonly subagent?: boolean;
  readonly threadTreeChild?: boolean;
  readonly threadTreeParent?: string | null;
  readonly remote?: boolean;
  readonly archived?: boolean;
}

export interface MoveProjectDialogState {
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
  project: Pick<WorkspaceLocalProject, "id" | "name"> | null | undefined,
): project is WorkspaceLocalProject {
  return project != null && project.id.length > 0;
}

/** Find the existing local native project currently owning `sessionId`, if any. */
export function findSessionLocalProject(
  sessionId: SessionId,
  projects: readonly WorkspaceLocalProject[] | undefined,
): WorkspaceLocalProject | undefined {
  if (projects === undefined) return undefined;
  return projects.find(
    (project) => isValidLocalProject(project) && project.sessionIds.includes(sessionId),
  );
}

/**
 * Check whether a session is eligible to show the "Move to project" menu entry.
 * Only local, native, non-draft, non-subagent, non-child, non-remote, non-archived sessions
 * with at least one other existing local native project target are allowed.
 * Pinned and sectioned sessions remain eligible because moving project never mutates pin,
 * section, or execution cwd.
 */
export function isProjectMovableSession(input: ProjectSessionEligibilityInput): boolean {
  if (!input.canMoveProject) return false;
  if (!input.nativeThreadIds.has(input.sessionId)) return false;
  if (input.blank === true) return false;
  if (input.subagent === true) return false;
  if (input.threadTreeChild === true) return false;
  if (input.threadTreeParent != null && input.threadTreeParent.length > 0) return false;
  if (input.remote === true) return false;
  if (input.archived === true || input.archivedSessionIds.includes(input.sessionId)) return false;
  const availableProjects = (input.localProjects ?? []).filter(isValidLocalProject);
  if (availableProjects.length === 0) return false;
  const currentProjectId = findSessionLocalProject(input.sessionId, availableProjects)?.id;
  return availableProjects.some((project) => project.id !== currentProjectId);
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
  readonly projects: readonly WorkspaceLocalProject[] | undefined;
  /** `null` before user selection; chosen native `projectId` otherwise. */
  readonly selectedTarget: string | null;
  readonly busy: boolean;
}): MoveProjectDialogState {
  const availableProjects = (input.projects ?? []).filter(isValidLocalProject);
  const currentProjectId = findSessionLocalProject(input.sessionId, availableProjects)?.id ?? "";
  const effectiveTarget = input.selectedTarget ?? currentProjectId;
  const targetDeleted =
    input.selectedTarget !== null &&
    input.selectedTarget !== "" &&
    !availableProjects.some((project) => project.id === input.selectedTarget);
  const canSubmit =
    !input.busy &&
    input.selectedTarget !== null &&
    input.selectedTarget !== "" &&
    !targetDeleted &&
    input.selectedTarget !== currentProjectId;
  return { availableProjects, currentProjectId, effectiveTarget, targetDeleted, canSubmit };
}

/**
 * Create a per-session in-flight lock coordinator for project moves.
 * Concurrent moves for different sessions proceed independently; duplicate moves for
 * the same session are skipped until the in-flight request settles.
 */
export function createProjectMoveCoordinator(options: {
  readonly execute: (
    sessionId: SessionId,
    projectId: string,
  ) => Promise<WorkspaceMoveSessionToProjectValue>;
  readonly onError?: (error: unknown) => void;
}): ProjectMoveCoordinator {
  const inFlight = new Set<SessionId>();
  let snapshot: ReadonlySet<SessionId> = new Set();
  const listeners = new Set<() => void>();

  const emit = (): void => {
    snapshot = new Set(inFlight);
    for (const listener of listeners) listener();
  };

  const movingSessionIds: HostObservable<ReadonlySet<SessionId>> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    movingSessionIds,
    isMoving: (sessionId) => inFlight.has(sessionId),
    async move(payload, moveOptions = {}) {
      if (inFlight.has(payload.sessionId)) {
        return { status: "skipped-in-flight" };
      }
      inFlight.add(payload.sessionId);
      emit();
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
        inFlight.delete(payload.sessionId);
        emit();
      }
    },
  };
}
