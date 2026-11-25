/**
 * Pure interaction logic for custom Thread section drag-and-drop, mobile/keyboard
 * reordering, and per-session in-flight locking.
 *
 * Kept framework-free so anchor calculations, drop/copy/cancel boundaries, and
 * concurrency guarantees can be verified directly by focused logic tests.
 */
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ArchivedFilter } from "../tree.ts";

/** Reserved built-in Pinned section ID in the native app-server protocol. */
export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";

/** True when a section is a user-manageable custom section rather than the built-in Pinned section. */
export function isManageableCustomSection(
  section: Pick<WorkspaceThreadSection, "id"> | null | undefined,
): boolean {
  return section != null && section.id.length > 0 && section.id !== PINNED_THREAD_SECTION_ID;
}

/** Authoritative move request dispatched to the Host/Web section move RPC. */
export interface SectionMovePayload {
  readonly sessionId: SessionId;
  readonly sectionId: string | null;
  /**
   * Optional positioning anchor within `sectionId`.
   * - Omitted (`undefined`): move out to unsectioned (`sectionId: null`) or legacy call.
   * - `null`: explicit append to the end of `sectionId`.
   * - `SessionId`: insert before that target member in `sectionId`.
   */
  readonly beforeSessionId?: SessionId | null;
}

/** Drag source identity when a section-eligible session starts dragging. */
export interface SectionDragSource {
  readonly sessionId: SessionId;
  /** Current custom section id, or `null` when dragged from an unsectioned list. */
  readonly sourceSectionId: string | null;
}

/** Valid drop target inside the sidebar for a section drag. */
export type SectionDropTarget =
  | { readonly kind: "section-end"; readonly sectionId: string }
  | {
      readonly kind: "section-row";
      readonly sectionId: string;
      readonly targetSessionId: SessionId;
      readonly half: "before" | "after";
    }
  | { readonly kind: "unsectioned" };

/** Local transient drag-hover state (never triggers RPC during dragover). */
export interface SectionDragState {
  readonly source: SectionDragSource;
  readonly over: SectionDropTarget | null;
}

export interface SectionSessionEligibilityInput {
  readonly sessionId: SessionId;
  readonly nativeThreadIds: ReadonlySet<SessionId>;
  readonly pinnedSessionIds: readonly SessionId[];
  readonly archivedSessionIds: readonly SessionId[];
  readonly blank?: boolean;
  readonly archived?: boolean;
  readonly pinned?: boolean;
  readonly remote?: boolean;
  readonly depth?: number;
  readonly movingSessionIds?: ReadonlySet<SessionId>;
}

export interface VisibleSectionMemberContext {
  readonly byId: SessionListState["byId"];
  readonly pinnedSessionIds: readonly SessionId[];
  readonly archivedSessionIds: readonly SessionId[];
  readonly archivedFilter: ArchivedFilter;
  /**
   * Optional set of session IDs currently visible after Host/Workspace filtering
   * (or the active `list.ids` set). When provided, members outside this set are
   * excluded so menu step anchors match the rendered sidebar rows.
   */
  readonly visibleSessionIds?: ReadonlySet<SessionId> | null;
}

export interface MoveSectionDialogState {
  readonly manageableSections: readonly WorkspaceThreadSection[];
  readonly currentSectionId: string;
  /** Effective `<select>` value: live current section before user choice, then user choice. */
  readonly effectiveTarget: string;
  /** True when the user explicitly selected a custom section that no longer exists in the live list. */
  readonly targetDeleted: boolean;
  readonly canSubmit: boolean;
}

export type SectionMoveOutcome =
  | { readonly status: "committed" }
  | { readonly status: "skipped-in-flight" }
  | { readonly status: "failed"; readonly error: unknown };

export interface SectionMoveCoordinator {
  /** Observable snapshot of sessions that currently have a move RPC in flight. */
  readonly movingSessionIds: HostObservable<ReadonlySet<SessionId>>;
  /** True while `sessionId` already has a move request in flight. */
  isMoving(sessionId: SessionId): boolean;
  /**
   * Commit one section move under a per-session in-flight lock.
   * Never mutates local snapshots optimistically; authoritative stream updates own order.
   */
  move(
    payload: SectionMovePayload,
    options?: { readonly notifyOnError?: boolean },
  ): Promise<SectionMoveOutcome>;
}

/** Media query identifying desktop fine-pointer environments that allow section drag-and-drop. */
export const FINE_POINTER_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

/** True when the current environment supports desktop fine-pointer drag-and-drop. */
export function isFinePointerDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(FINE_POINTER_MEDIA_QUERY).matches;
}

/**
 * Check whether a session is eligible to participate in custom section moves.
 * Only local, harness-backed, non-draft, non-archived, non-pinned, top-level sessions are allowed.
 */
export function isSectionMovableSession(input: SectionSessionEligibilityInput): boolean {
  if (!input.nativeThreadIds.has(input.sessionId)) return false;
  if (input.blank === true) return false;
  if (input.archived === true || input.archivedSessionIds.includes(input.sessionId)) return false;
  if (input.pinned === true || input.pinnedSessionIds.includes(input.sessionId)) return false;
  if (input.remote === true) return false;
  if ((input.depth ?? 0) > 0) return false;
  if (input.movingSessionIds?.has(input.sessionId) === true) return false;
  return true;
}

/** True when a top-level active row should render an in-flight section-move pending state. */
export function isSectionRowMoving(input: {
  readonly depth?: number;
  readonly blank?: boolean;
  readonly archived?: boolean;
  readonly moving: boolean;
}): boolean {
  return (
    input.moving && (input.depth ?? 0) === 0 && input.blank !== true && input.archived !== true
  );
}

/** Find the manageable custom section currently owning `sessionId`, if any. */
export function findSessionCustomSection(
  sessionId: SessionId,
  sections: readonly WorkspaceThreadSection[] | undefined,
): WorkspaceThreadSection | undefined {
  if (sections === undefined) return undefined;
  return sections.find(
    (section) => isManageableCustomSection(section) && section.threadIds.includes(sessionId),
  );
}

/**
 * Derive the ordered visible, active, non-pinned, non-archived member IDs of a custom section.
 * Matches sidebar presentation while excluding archived/pinned/unloaded rows from anchor math.
 */
export function visibleCustomSectionThreadIds(
  section: WorkspaceThreadSection,
  context: VisibleSectionMemberContext,
): SessionId[] {
  if (!isManageableCustomSection(section) || context.archivedFilter === "only") return [];
  const pinned = new Set(context.pinnedSessionIds);
  const archived = new Set(context.archivedSessionIds);
  const seen = new Set<SessionId>();
  const result: SessionId[] = [];
  for (const threadId of section.threadIds) {
    if (seen.has(threadId)) continue;
    if (context.visibleSessionIds != null && !context.visibleSessionIds.has(threadId)) continue;
    const summary = context.byId[threadId];
    if (summary === undefined || summary.blank || summary.origin === "subagent") continue;
    if (archived.has(threadId) || pinned.has(threadId)) continue;
    seen.add(threadId);
    result.push(threadId);
  }
  return result;
}

/**
 * Derive live options, current ownership, and submission validity for the move-to-section dialog.
 * Before the user makes a selection (`selectedTarget === null`), tracks the session's live
 * ownership and keeps submission disabled. Once the user picks a target, preserves that choice;
 * if a selected custom section is deleted while open, keeps the selection intact (without
 * auto-switching to unsectioned) and blocks submission until a valid destination is chosen.
 */
export function resolveMoveSectionDialogState(input: {
  readonly sessionId: SessionId;
  readonly sections: readonly WorkspaceThreadSection[] | undefined;
  /** `null` before user selection; `""` for explicit unsectioned; section ID otherwise. */
  readonly selectedTarget: string | null;
  readonly busy: boolean;
}): MoveSectionDialogState {
  const manageableSections = (input.sections ?? []).filter(isManageableCustomSection);
  const currentSectionId =
    manageableSections.find((section) => section.threadIds.includes(input.sessionId))?.id ?? "";
  const effectiveTarget = input.selectedTarget ?? currentSectionId;
  const targetDeleted =
    input.selectedTarget !== null &&
    input.selectedTarget !== "" &&
    !manageableSections.some((section) => section.id === input.selectedTarget);
  const canSubmit =
    !input.busy &&
    input.selectedTarget !== null &&
    !targetDeleted &&
    input.selectedTarget !== currentSectionId;
  return { manageableSections, currentSectionId, effectiveTarget, targetDeleted, canSubmit };
}

/** Return the row immediately above the pointer's gap, within the same pinned block. */
export function localReorderGapTarget(
  event: { target: EventTarget | null; currentTarget: HTMLElement; clientY: number },
  pinned: boolean,
): { id: SessionId; half: "after" } | null {
  if (event.target !== event.currentTarget) return null;
  const expected = String(pinned);
  let previousId: string | null = null;
  let previousBottom = 0;
  for (const branch of event.currentTarget.children) {
    const id = branch.getAttribute("data-thread-branch");
    if (
      id === null ||
      branch.querySelector("[data-thread-pinned]")?.getAttribute("data-thread-pinned") !== expected
    ) {
      previousId = null;
      continue;
    }
    const { top, bottom } = branch.getBoundingClientRect();
    if (previousId !== null && previousBottom <= event.clientY && event.clientY <= top) {
      return { id: previousId as SessionId, half: "after" };
    }
    previousId = id;
    previousBottom = bottom;
  }
  return null;
}

/**
 * Decide whether a drop event is allowed to commit a section move.
 * Rejects duplicate commits, cancelled drags (Escape / invalid area), and Composer copy drops.
 */
export function canCommitSectionDrop(input: {
  readonly committed: boolean;
  readonly cancelled: boolean;
  readonly dropEffect?: string | null;
}): boolean {
  if (input.committed || input.cancelled) return false;
  if (input.dropEffect === "copy") return false;
  return true;
}

/**
 * Resolve a validated sidebar drop into a single authoritative section-move payload,
 * or `null` when the drop is invalid or results in no position change.
 */
export function resolveSectionDropMove(
  source: SectionDragSource,
  target: SectionDropTarget,
  sections: readonly WorkspaceThreadSection[],
  visibleSectionRows?: ReadonlyMap<string, readonly SessionId[]>,
): SectionMovePayload | null {
  if (target.kind === "unsectioned") {
    if (source.sourceSectionId === null) return null;
    return { sessionId: source.sessionId, sectionId: null };
  }

  const section = sections.find((candidate) => candidate.id === target.sectionId);
  if (section === undefined || !isManageableCustomSection(section)) return null;

  if (target.kind === "section-end") {
    if (
      source.sourceSectionId === section.id &&
      section.threadIds.length > 0 &&
      section.threadIds[section.threadIds.length - 1] === source.sessionId
    ) {
      return null;
    }
    return {
      sessionId: source.sessionId,
      sectionId: section.id,
      beforeSessionId: null,
    };
  }

  if (target.targetSessionId === source.sessionId) return null;
  if (!section.threadIds.includes(target.targetSessionId)) return null;

  const visibleIds = visibleSectionRows?.get(section.id) ?? section.threadIds;
  const targetIndex = visibleIds.indexOf(target.targetSessionId);
  if (targetIndex === -1) return null;

  if (target.half === "before") {
    if (source.sourceSectionId === section.id) {
      const sourceIndex = visibleIds.indexOf(source.sessionId);
      if (sourceIndex !== -1 && targetIndex === sourceIndex + 1) return null;
    }
    return {
      sessionId: source.sessionId,
      sectionId: section.id,
      beforeSessionId: target.targetSessionId,
    };
  }

  const nextId = visibleIds[targetIndex + 1];
  if (nextId === source.sessionId) return null;
  if (nextId === undefined) {
    if (
      source.sourceSectionId === section.id &&
      section.threadIds.length > 0 &&
      section.threadIds[section.threadIds.length - 1] === source.sessionId
    ) {
      return null;
    }
    return {
      sessionId: source.sessionId,
      sectionId: section.id,
      beforeSessionId: null,
    };
  }
  if (!section.threadIds.includes(nextId)) {
    return {
      sessionId: source.sessionId,
      sectionId: section.id,
      beforeSessionId: null,
    };
  }
  return {
    sessionId: source.sessionId,
    sectionId: section.id,
    beforeSessionId: nextId,
  };
}

/**
 * Compute the anchor payload for mobile/keyboard step reordering ("up" or "down")
 * within a custom section. Returns `null` when already at the boundary (first/last)
 * or when the session cannot be moved.
 */
export function resolveSectionStepMove(
  sessionId: SessionId,
  direction: "up" | "down",
  section: WorkspaceThreadSection,
  visibleIds: readonly SessionId[],
): SectionMovePayload | null {
  if (!isManageableCustomSection(section)) return null;
  const index = visibleIds.indexOf(sessionId);
  if (index === -1) return null;

  if (direction === "up") {
    if (index <= 0) return null;
    const beforeSessionId = visibleIds[index - 1];
    if (
      beforeSessionId === undefined ||
      beforeSessionId === sessionId ||
      !section.threadIds.includes(beforeSessionId)
    ) {
      return null;
    }
    return { sessionId, sectionId: section.id, beforeSessionId };
  }

  if (index >= visibleIds.length - 1) return null;
  const afterNext = visibleIds[index + 2];
  if (afterNext === sessionId) return null;
  if (afterNext === undefined || !section.threadIds.includes(afterNext)) {
    return { sessionId, sectionId: section.id, beforeSessionId: null };
  }
  return { sessionId, sectionId: section.id, beforeSessionId: afterNext };
}

/**
 * Create a per-session in-flight lock coordinator for section moves.
 * Concurrent moves for different sessions proceed independently; duplicate moves for
 * the same session are ignored until the in-flight request settles.
 */
export function createSectionMoveCoordinator(options: {
  readonly execute: (
    sessionId: SessionId,
    sectionId: string | null,
    beforeSessionId?: SessionId | null,
  ) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}): SectionMoveCoordinator {
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
        await options.execute(payload.sessionId, payload.sectionId, payload.beforeSessionId);
        return { status: "committed" };
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
