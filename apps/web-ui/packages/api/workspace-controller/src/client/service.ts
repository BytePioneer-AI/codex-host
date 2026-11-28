/** React-free Client Workspace service and command facade. */

import { Service, type Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RemoteFailure } from "@deepseek-ai/dsh-typert-protocol";
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace/types";
import type {
  WorkspaceCreateThreadSectionValue,
  WorkspaceDeleteThreadSectionValue,
  WorkspaceMoveSessionToProjectValue,
  WorkspaceUpdateThreadSectionValue,
  WorkspaceView,
} from "../types.ts";
import type { ClientWorkspaceModel, WorkspaceSnapshot } from "./model.ts";

/** Structured create failure for callers that distinguish Host business errors. */
export class WorkspaceCreateError extends Error {
  override readonly name = "WorkspaceCreateError";

  /** @param rpcError - Host business or folded carrier failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace create failed: ${rpcError.code}: ${rpcError.message}`);
  }
}

/**
 * Archive failed on the Host. `rpcError.code` distinguishes the active-session
 * refusal (`workspace/session-active`, whose details name what still runs)
 * from a missing session or a carrier fault.
 */
export class WorkspaceArchiveError extends Error {
  override readonly name = "WorkspaceArchiveError";

  /** @param rpcError - Host business or folded carrier failure. */
  constructor(readonly rpcError: RemoteFailure) {
    super(`workspace session archive failed: ${rpcError.code}: ${rpcError.message}`);
  }
}

/** Bare observable source for the Workspace Controller snapshot. */
export interface WorkspaceSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): WorkspaceSnapshot;
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/** Workspace Controller's Client service face. */
export interface IWorkspaces {
  /** Host-authoritative Workspace rows, order, archive set, and follow lifecycle. */
  readonly list: WorkspaceSource;
  /**
   * Register an existing path as a Workspace.
   * @param input - Host create payload.
   * @returns the created or idempotently resolved Workspace.
   */
  create(input: { path: string }): Promise<WorkspaceView>;
  /**
   * Initialize or reuse the default Workspace.
   * @param signal - caller lifetime.
   * @returns the prepared Workspace, or undefined when first-use initialization is ineligible; rejects on preparation failure.
   */
  initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined>;
  /**
   * Rename a Workspace.
   * @param workspaceId - target Workspace.
   * @param title - new display title.
   * @returns the renamed Workspace.
   */
  rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>;
  /**
   * Delete a Workspace registration without deleting Sessions or files.
   * @param workspaceId - target Workspace.
   */
  delete(workspaceId: WorkspaceId): Promise<void>;
  /**
   * Move a Workspace within the Host registry order.
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - anchor Workspace; omitted appends.
   */
  insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>;
  /**
   * Archive a Session from Workspace grouping surfaces.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   * @throws {WorkspaceArchiveError} when the Host refuses; without `stopActivity` a Session with
   *   running work fails as `workspace/session-active`, its details naming what runs.
   */
  archiveSession(
    sessionId: SessionId,
    options?: { readonly stopActivity?: boolean },
  ): Promise<void>;
  /**
   * Unarchive a Session from the archived Session list.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>;
  /**
   * Pin a Session ahead of unpinned Sessions on Workspace grouping surfaces.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>;
  /**
   * Remove a Session's pin without changing its saved Session order.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>;
  /** Pin or unpin a Workspace in the shared sidebar projection. */
  setWorkspacePinned?(workspaceId: WorkspaceId, pinned: boolean): Promise<void>;
  /** Place a local project in a sidebar section, or return it to Workspaces. */
  moveWorkspaceToSection?(workspaceId: WorkspaceId, sectionId: string | null): Promise<void>;
  moveSessionToSection?(sessionId: SessionId, sectionId: string | null): Promise<void>;

  /** Change or clear a Session's native project without changing section, pin, or cwd. */
  moveSessionToProject?(
    sessionId: SessionId,
    projectId: string | null,
  ): Promise<WorkspaceMoveSessionToProjectValue>;
  /** Create a custom Thread section with a non-empty name. */
  createThreadSection?(name: string): Promise<WorkspaceCreateThreadSectionValue>;
  /** Rename a custom Thread section while omitting appearance to preserve existing styling. */
  updateThreadSection?(sectionId: string, name: string): Promise<WorkspaceUpdateThreadSectionValue>;
  /** Delete a custom Thread section without deleting or archiving its Threads. */
  deleteThreadSection?(sectionId: string): Promise<WorkspaceDeleteThreadSectionValue>;
  /**
   * Move a Session within one Workspace account.
   * @param workspaceId - owning Workspace.
   * @param sessionId - Session to move.
   * @param beforeSessionId - anchor Session; omitted appends.
   * @returns the changed Workspace.
   */
  insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView>;
}

/** Owns the bare Workspace snapshot and Workspace-only commands. */
export class WorkspaceController extends Service implements IWorkspaces {
  readonly list: WorkspaceSource;

  /**
   * @param ctx - Client root Context.
   * @param model - Remote-backed Workspace state model.
   */
  constructor(
    ctx: Context,
    private readonly model: ClientWorkspaceModel,
  ) {
    super(ctx, "workspaces");
    this.list = model;
  }

  async create(input: { path: string }): Promise<WorkspaceView> {
    const result = await this.model.create(input);
    if (!result.ok) throw new WorkspaceCreateError(result.error);
    return result.value.workspace;
  }

  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    const result = await this.model.initializeDefault(signal);
    if (!result.ok) throw new WorkspaceCreateError(result.error);
    return result.value?.workspace;
  }

  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    const result = await this.model.rename(workspaceId, title);
    if (!result.ok) throw commandError("rename", result.error);
    return result.value.workspace;
  }

  async delete(workspaceId: WorkspaceId): Promise<void> {
    const result = await this.model.delete(workspaceId);
    if (!result.ok) throw commandError("delete", result.error);
  }

  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    const result = await this.model.insertBefore(workspaceId, beforeWorkspaceId);
    if (!result.ok) throw commandError("reorder", result.error);
  }

  async archiveSession(
    sessionId: SessionId,
    options: { readonly stopActivity?: boolean } = {},
  ): Promise<void> {
    const result = await this.model.archiveSession(sessionId, options);
    if (!result.ok) throw new WorkspaceArchiveError(result.error);
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unarchiveSession(sessionId);
    if (!result.ok) throw commandError("session unarchive", result.error);
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.pinSession(sessionId);
    if (!result.ok) throw commandError("session pin", result.error);
  }

  async moveSessionToProject(
    sessionId: SessionId,
    projectId: string | null,
  ): Promise<WorkspaceMoveSessionToProjectValue> {
    const result = await this.model.moveSessionToProject({ sessionId, projectId });
    if (!result.ok) {
      if (result.error.code === "gateway/internal" || result.error.code === "gateway/cancelled")
        return { status: "unknown" };
      throw commandError("move to project", result.error);
    }
    if (result.value.status === "confirmed" && result.value.projectId !== projectId)
      return { status: "unknown" };
    return result.value;
  }

  async moveSessionToSection(sessionId: SessionId, sectionId: string | null): Promise<void> {
    const result = await this.model.moveSessionToSection({ sessionId, sectionId });
    if (!result.ok) throw commandError("move to section", result.error);
    if (result.value.sectionId !== sectionId)
      throw new Error("The requested section change was not confirmed.");
  }

  async moveWorkspaceToSection(workspaceId: WorkspaceId, sectionId: string | null): Promise<void> {
    const result = await this.model.moveWorkspaceToSection({ workspaceId, sectionId });
    if (!result.ok) throw commandError("move project to section", result.error);
    if (result.value.sectionId !== sectionId)
      throw new Error("The requested section change was not confirmed.");
  }

  async createThreadSection(name: string): Promise<WorkspaceCreateThreadSectionValue> {
    const result = await this.model.createThreadSection({ name });
    if (!result.ok) throw commandError("create thread section", result.error);
    return result.value;
  }

  async updateThreadSection(
    sectionId: string,
    name: string,
  ): Promise<WorkspaceUpdateThreadSectionValue> {
    const result = await this.model.updateThreadSection({ sectionId, name });
    if (!result.ok) throw commandError("update thread section", result.error);
    return result.value;
  }

  async deleteThreadSection(sectionId: string): Promise<WorkspaceDeleteThreadSectionValue> {
    const result = await this.model.deleteThreadSection({ sectionId });
    if (!result.ok) throw commandError("delete thread section", result.error);
    return result.value;
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    const result = await this.model.unpinSession(sessionId);
    if (!result.ok) throw commandError("session unpin", result.error);
  }

  async setWorkspacePinned(workspaceId: WorkspaceId, pinned: boolean): Promise<void> {
    const result = await this.model.setWorkspacePinned({ workspaceId, pinned });
    if (!result.ok) throw commandError(pinned ? "pin" : "unpin", result.error);
  }

  async insertSessionBefore(
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ): Promise<WorkspaceView> {
    const result = await this.model.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
    if (!result.ok) throw commandError("move", result.error);
    return result.value.workspace;
  }
}

function commandError(operation: string, failure: RemoteFailure): Error {
  return new Error(`workspace ${operation} failed: ${failure.code}: ${failure.message}`);
}
