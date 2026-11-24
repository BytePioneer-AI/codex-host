import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSummary } from "@deepseek-ai/dsh-api-session-controller/client";
import type { WorkspaceThreadSection } from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  canCommitSectionDrop,
  collectLocalReorderRowBounds,
  createSectionMoveCoordinator,
  isLocalReorderRowGap,
  isSectionMovableSession,
  isSectionRowMoving,
  PINNED_THREAD_SECTION_ID,
  resolveMoveSectionDialogState,
  resolveSectionDropMove,
  resolveSectionStepMove,
  visibleCustomSectionThreadIds,
} from "../src/client/rows/section-dnd.ts";

const sid = (value: string): SessionId => value as SessionId;

function summary(
  id: string,
  overrides: Partial<Pick<SessionSummary, "blank" | "origin">> = {},
): SessionSummary {
  return {
    id: sid(id),
    blank: overrides.blank ?? false,
    origin: overrides.origin ?? "user",
  } as SessionSummary;
}

describe("isSectionMovableSession", () => {
  it("allows only local, non-draft, non-archived, non-pinned, top-level, idle sessions", () => {
    const nativeThreadIds = new Set([sid("codex-1"), sid("claude-1")]);
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
      }),
      true,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("claude-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        depth: 0,
      }),
      true,
    );
    // Rejects non-native (e.g. native subagent or remote excluded from nativeThreadIds)
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("subagent-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
      }),
      false,
    );
    // Rejects draft, archived, pinned, remote, nested child, and in-flight
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        blank: true,
      }),
      false,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [sid("codex-1")],
        archivedSessionIds: [],
      }),
      false,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [sid("codex-1")],
      }),
      false,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        remote: true,
      }),
      false,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        depth: 1,
      }),
      false,
    );
    assert.equal(
      isSectionMovableSession({
        sessionId: sid("codex-1"),
        nativeThreadIds,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        movingSessionIds: new Set([sid("codex-1")]),
      }),
      false,
    );
  });
});

describe("isSectionRowMoving", () => {
  it("shows pending state only on top-level active rows with an in-flight section move", () => {
    assert.equal(isSectionRowMoving({ moving: true }), true);
    assert.equal(
      isSectionRowMoving({ moving: true, depth: 0, blank: false, archived: false }),
      true,
    );
    assert.equal(isSectionRowMoving({ moving: false }), false);
    assert.equal(isSectionRowMoving({ moving: true, depth: 1 }), false);
    assert.equal(isSectionRowMoving({ moving: true, blank: true }), false);
    assert.equal(isSectionRowMoving({ moving: true, archived: true }), false);
  });
});

describe("resolveSectionDropMove", () => {
  const sections: readonly WorkspaceThreadSection[] = [
    { id: "sec-a", name: "Alpha", threadIds: [sid("a1"), sid("a2"), sid("a3")] },
    { id: "sec-b", name: "Beta", threadIds: [] },
    { id: PINNED_THREAD_SECTION_ID, name: "Pinned", threadIds: [sid("p1")] },
  ];
  const visible = new Map<string, readonly SessionId[]>([
    ["sec-a", [sid("a1"), sid("a2"), sid("a3")]],
    ["sec-b", []],
  ]);

  it("uses explicit null when dropping onto a section header or empty state", () => {
    // Unsectioned -> empty section
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("u1"), sourceSectionId: null },
        { kind: "section-end", sectionId: "sec-b" },
        sections,
        visible,
      ),
      { sessionId: sid("u1"), sectionId: "sec-b", beforeSessionId: null },
    );
    // Same section, non-last item -> explicit null moves to end
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("a1"), sourceSectionId: "sec-a" },
        { kind: "section-end", sectionId: "sec-a" },
        sections,
        visible,
      ),
      { sessionId: sid("a1"), sectionId: "sec-a", beforeSessionId: null },
    );
    // Same section, already last item -> no-op
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("a3"), sourceSectionId: "sec-a" },
        { kind: "section-end", sectionId: "sec-a" },
        sections,
        visible,
      ),
      null,
    );
    // Pinned section is never a valid drop target
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("u1"), sourceSectionId: null },
        { kind: "section-end", sectionId: PINNED_THREAD_SECTION_ID },
        sections,
        visible,
      ),
      null,
    );
  });

  it("computes upper/lower half anchors for same-section and cross-section row drops", () => {
    // Same section: a1 after a2 -> before a3
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("a1"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a2"), half: "after" },
        sections,
        visible,
      ),
      { sessionId: sid("a1"), sectionId: "sec-a", beforeSessionId: sid("a3") },
    );
    // Same section: a1 after a3 (last) -> explicit null
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("a1"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a3"), half: "after" },
        sections,
        visible,
      ),
      { sessionId: sid("a1"), sectionId: "sec-a", beforeSessionId: null },
    );
    // Same section: a3 before a1 -> before a1
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("a3"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a1"), half: "before" },
        sections,
        visible,
      ),
      { sessionId: sid("a3"), sectionId: "sec-a", beforeSessionId: sid("a1") },
    );
    // Same section no-ops: self-drop, a1 before a2, a3 after a2
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("a1"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a1"), half: "before" },
        sections,
        visible,
      ),
      null,
    );
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("a1"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a2"), half: "before" },
        sections,
        visible,
      ),
      null,
    );
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("a3"), sourceSectionId: "sec-a" },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a2"), half: "after" },
        sections,
        visible,
      ),
      null,
    );
    // Cross section: u1 before a2 -> before a2; u1 after a3 -> explicit null
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("u1"), sourceSectionId: null },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a2"), half: "before" },
        sections,
        visible,
      ),
      { sessionId: sid("u1"), sectionId: "sec-a", beforeSessionId: sid("a2") },
    );
    assert.deepEqual(
      resolveSectionDropMove(
        { sessionId: sid("u1"), sourceSectionId: null },
        { kind: "section-row", sectionId: "sec-a", targetSessionId: sid("a3"), half: "after" },
        sections,
        visible,
      ),
      { sessionId: sid("u1"), sectionId: "sec-a", beforeSessionId: null },
    );
  });

  it("moves back to unsectioned omitting anchor, and ignores unsectioned-to-unsectioned", () => {
    const moveOut = resolveSectionDropMove(
      { sessionId: sid("a1"), sourceSectionId: "sec-a" },
      { kind: "unsectioned" },
      sections,
      visible,
    );
    assert.deepEqual(moveOut, { sessionId: sid("a1"), sectionId: null });
    assert.equal(Object.hasOwn(moveOut!, "beforeSessionId"), false);

    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("u1"), sourceSectionId: null },
        { kind: "unsectioned" },
        sections,
        visible,
      ),
      null,
    );
  });
});

describe("canCommitSectionDrop", () => {
  it("blocks Composer copy drops, Escape cancellations, and duplicate commits", () => {
    assert.equal(
      canCommitSectionDrop({ committed: false, cancelled: false, dropEffect: "move" }),
      true,
    );
    assert.equal(
      canCommitSectionDrop({ committed: false, cancelled: false, dropEffect: "copy" }),
      false,
    );
    assert.equal(
      canCommitSectionDrop({ committed: false, cancelled: true, dropEffect: "move" }),
      false,
    );
    assert.equal(
      canCommitSectionDrop({ committed: true, cancelled: false, dropEffect: "move" }),
      false,
    );
  });
});

describe("resolveSectionStepMove & visibleCustomSectionThreadIds", () => {
  const section: WorkspaceThreadSection = {
    id: "sec-a",
    name: "Alpha",
    threadIds: [sid("a1"), sid("a2"), sid("a3")],
  };

  it("disables first up / last down and computes exact anchors for mobile/keyboard steps", () => {
    const order = [sid("a1"), sid("a2"), sid("a3")];
    assert.equal(resolveSectionStepMove(sid("a1"), "up", section, order), null);
    assert.deepEqual(resolveSectionStepMove(sid("a1"), "down", section, order), {
      sessionId: sid("a1"),
      sectionId: "sec-a",
      beforeSessionId: sid("a3"),
    });
    assert.deepEqual(resolveSectionStepMove(sid("a2"), "up", section, order), {
      sessionId: sid("a2"),
      sectionId: "sec-a",
      beforeSessionId: sid("a1"),
    });
    assert.deepEqual(resolveSectionStepMove(sid("a2"), "down", section, order), {
      sessionId: sid("a2"),
      sectionId: "sec-a",
      beforeSessionId: null,
    });
    assert.deepEqual(resolveSectionStepMove(sid("a3"), "up", section, order), {
      sessionId: sid("a3"),
      sectionId: "sec-a",
      beforeSessionId: sid("a2"),
    });
    assert.equal(resolveSectionStepMove(sid("a3"), "down", section, order), null);
    // Single item: both directions disabled
    assert.equal(resolveSectionStepMove(sid("a1"), "up", section, [sid("a1")]), null);
    assert.equal(resolveSectionStepMove(sid("a1"), "down", section, [sid("a1")]), null);
  });

  it("filters pinned, archived, blank, subagent, unloaded, and duplicate threads from visible order", () => {
    const mixed: WorkspaceThreadSection = {
      id: "sec-m",
      name: "Mixed",
      threadIds: [
        sid("live-1"),
        sid("live-1"),
        sid("archived-1"),
        sid("pinned-1"),
        sid("blank-1"),
        sid("sub-1"),
        sid("unloaded-1"),
        sid("live-2"),
      ],
    };
    const visible = visibleCustomSectionThreadIds(mixed, {
      byId: {
        [sid("live-1")]: summary("live-1"),
        [sid("archived-1")]: summary("archived-1"),
        [sid("pinned-1")]: summary("pinned-1"),
        [sid("blank-1")]: summary("blank-1", { blank: true }),
        [sid("sub-1")]: summary("sub-1", { origin: "subagent" }),
        [sid("live-2")]: summary("live-2"),
      },
      pinnedSessionIds: [sid("pinned-1")],
      archivedSessionIds: [sid("archived-1")],
      archivedFilter: "default",
    });
    assert.deepEqual(visible, [sid("live-1"), sid("live-2")]);
  });

  it("applies Host/Workspace visibleSessionIds filter before computing step anchors", () => {
    const filteredSection: WorkspaceThreadSection = {
      id: "sec-f",
      name: "Filtered",
      threadIds: [sid("a"), sid("b-hidden"), sid("c")],
    };
    const visible = visibleCustomSectionThreadIds(filteredSection, {
      byId: {
        [sid("a")]: summary("a"),
        [sid("b-hidden")]: summary("b-hidden"),
        [sid("c")]: summary("c"),
      },
      pinnedSessionIds: [],
      archivedSessionIds: [],
      archivedFilter: "default",
      visibleSessionIds: new Set([sid("a"), sid("c")]),
    });
    assert.deepEqual(visible, [sid("a"), sid("c")]);
    // Moving "a" down skips hidden "b-hidden" and moves after "c" (explicit null), never targeting "b-hidden"
    assert.deepEqual(resolveSectionStepMove(sid("a"), "down", filteredSection, visible), {
      sessionId: sid("a"),
      sectionId: "sec-f",
      beforeSessionId: null,
    });
    // When only "a" is visible, both up and down are disabled
    const onlyA = visibleCustomSectionThreadIds(filteredSection, {
      byId: {
        [sid("a")]: summary("a"),
        [sid("b-hidden")]: summary("b-hidden"),
        [sid("c")]: summary("c"),
      },
      pinnedSessionIds: [],
      archivedSessionIds: [],
      archivedFilter: "default",
      visibleSessionIds: new Set([sid("a")]),
    });
    assert.deepEqual(onlyA, [sid("a")]);
    assert.equal(resolveSectionStepMove(sid("a"), "up", filteredSection, onlyA), null);
    assert.equal(resolveSectionStepMove(sid("a"), "down", filteredSection, onlyA), null);
  });
});

describe("isLocalReorderRowGap", () => {
  it("accepts only inter-row gaps on the container itself and rejects controls like load-more", () => {
    const container = {} as EventTarget;
    const loadMoreButton = {} as EventTarget;
    const rowBounds = [
      { top: 100, bottom: 132 },
      { top: 134, bottom: 166 },
    ];
    // Directly inside the 2px gap between row 0 and row 1
    assert.equal(
      isLocalReorderRowGap(
        { target: container, currentTarget: container, clientY: 133 },
        rowBounds,
      ),
      true,
    );
    // Hovering over a non-sortable child control (e.g. "Load more" button)
    assert.equal(
      isLocalReorderRowGap(
        { target: loadMoreButton, currentTarget: container, clientY: 133 },
        rowBounds,
      ),
      false,
    );
    // Below the last row (e.g. container padding near "Load more") or above the first row
    assert.equal(
      isLocalReorderRowGap(
        { target: container, currentTarget: container, clientY: 170 },
        rowBounds,
      ),
      false,
    );
    assert.equal(
      isLocalReorderRowGap({ target: container, currentTarget: container, clientY: 96 }, rowBounds),
      false,
    );
    // Single row has no inter-row gap
    assert.equal(
      isLocalReorderRowGap({ target: container, currentTarget: container, clientY: 133 }, [
        { top: 100, bottom: 132 },
      ]),
      false,
    );
  });

  it("reads data-thread-pinned from wrapped branch descendants and filters by pinned state", () => {
    const branch = (pinned: boolean | null, top: number, bottom: number, isBranch = true) => ({
      hasAttribute: (name: string) => isBranch && name === "data-thread-branch",
      // Simulates HoverCard wrapping the row element so firstElementChild lacks data-thread-pinned.
      firstElementChild: { dataset: {} },
      querySelector: (selector: string) =>
        selector === "[data-thread-pinned]" && pinned !== null
          ? {
              getAttribute: (name: string) =>
                name === "data-thread-pinned" ? String(pinned) : null,
            }
          : null,
      getBoundingClientRect: () => ({ top, bottom }),
    });
    const container = {
      children: [
        branch(true, 60, 92),
        branch(false, 100, 132),
        branch(false, 134, 166),
        branch(null, 168, 200, false), // e.g. Load more button
      ],
    };

    const unpinnedBounds = collectLocalReorderRowBounds(container, false);
    assert.deepEqual(unpinnedBounds, [
      { top: 100, bottom: 132 },
      { top: 134, bottom: 166 },
    ]);
    assert.equal(
      isLocalReorderRowGap(
        {
          target: container as unknown as EventTarget,
          currentTarget: container as unknown as EventTarget,
          clientY: 133,
        },
        unpinnedBounds,
      ),
      true,
    );
    // Gap above unpinned rows (between pinned row and first unpinned row) is rejected
    assert.equal(
      isLocalReorderRowGap(
        {
          target: container as unknown as EventTarget,
          currentTarget: container as unknown as EventTarget,
          clientY: 96,
        },
        unpinnedBounds,
      ),
      false,
    );
    // Single pinned branch produces no inter-row gap for pinned drags
    const pinnedBounds = collectLocalReorderRowBounds(container, true);
    assert.deepEqual(pinnedBounds, [{ top: 60, bottom: 92 }]);
    assert.equal(
      isLocalReorderRowGap(
        {
          target: container as unknown as EventTarget,
          currentTarget: container as unknown as EventTarget,
          clientY: 96,
        },
        pinnedBounds,
      ),
      false,
    );
  });
});

describe("resolveMoveSectionDialogState", () => {
  it("tracks live ownership with submit disabled until the user selects, then preserves user choice", () => {
    const initial: readonly WorkspaceThreadSection[] = [
      { id: "sec-a", name: "Alpha", threadIds: [sid("s1")] },
      { id: "sec-b", name: "Beta", threadIds: [] },
      { id: PINNED_THREAD_SECTION_ID, name: "Pinned", threadIds: [] },
    ];
    // Before user selects: displays live owner sec-a with submit disabled
    const untouched = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: initial,
      selectedTarget: null,
      busy: false,
    });
    assert.equal(untouched.currentSectionId, "sec-a");
    assert.equal(untouched.effectiveTarget, "sec-a");
    assert.equal(untouched.targetDeleted, false);
    assert.equal(untouched.canSubmit, false);

    // Another client moves s1 from sec-a to sec-b before user selects: follows sec-b and stays disabled
    const remotelyMoved = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: [
        { id: "sec-a", name: "Alpha", threadIds: [] },
        { id: "sec-b", name: "Beta", threadIds: [sid("s1")] },
      ],
      selectedTarget: null,
      busy: false,
    });
    assert.equal(remotelyMoved.currentSectionId, "sec-b");
    assert.equal(remotelyMoved.effectiveTarget, "sec-b");
    assert.equal(remotelyMoved.targetDeleted, false);
    assert.equal(remotelyMoved.canSubmit, false);

    // Session started unsectioned, another client moves it to sec-a before user selects: follows sec-a and stays disabled
    const remotelySectioned = resolveMoveSectionDialogState({
      sessionId: sid("u1"),
      sections: [{ id: "sec-a", name: "Alpha", threadIds: [sid("u1")] }],
      selectedTarget: null,
      busy: false,
    });
    assert.equal(remotelySectioned.effectiveTarget, "sec-a");
    assert.equal(remotelySectioned.canSubmit, false);

    // User explicitly picks sec-b while s1 is in sec-a
    const picked = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: initial,
      selectedTarget: "sec-b",
      busy: false,
    });
    assert.deepEqual(
      picked.manageableSections.map((s) => s.id),
      ["sec-a", "sec-b"],
    );
    assert.equal(picked.effectiveTarget, "sec-b");
    assert.equal(picked.currentSectionId, "sec-a");
    assert.equal(picked.targetDeleted, false);
    assert.equal(picked.canSubmit, true);

    // Another client creates sec-c: sec-c appears and valid selection sec-b remains submittable
    const added = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: [...initial, { id: "sec-c", name: "Gamma", threadIds: [] }],
      selectedTarget: "sec-b",
      busy: false,
    });
    assert.deepEqual(
      added.manageableSections.map((s) => s.id),
      ["sec-a", "sec-b", "sec-c"],
    );
    assert.equal(added.effectiveTarget, "sec-b");
    assert.equal(added.targetDeleted, false);
    assert.equal(added.canSubmit, true);

    // Another client deletes sec-b: targetDeleted becomes true and submit is blocked (not auto-switched to "")
    const deleted = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: [
        { id: "sec-a", name: "Alpha", threadIds: [sid("s1")] },
        { id: "sec-c", name: "Gamma", threadIds: [] },
      ],
      selectedTarget: "sec-b",
      busy: false,
    });
    assert.equal(deleted.effectiveTarget, "sec-b");
    assert.equal(deleted.targetDeleted, true);
    assert.equal(deleted.canSubmit, false);

    // Explicit unsectioned target ("") remains valid and submittable when session is in sec-a
    const unsectioned = resolveMoveSectionDialogState({
      sessionId: sid("s1"),
      sections: [{ id: "sec-a", name: "Alpha", threadIds: [sid("s1")] }],
      selectedTarget: "",
      busy: false,
    });
    assert.equal(unsectioned.effectiveTarget, "");
    assert.equal(unsectioned.targetDeleted, false);
    assert.equal(unsectioned.canSubmit, true);
  });
});

describe("createSectionMoveCoordinator", () => {
  it("enforces per-session in-flight locks, allows concurrent different sessions, and notifies on failure", async () => {
    const calls: Array<{
      sessionId: SessionId;
      sectionId: string | null;
      beforeSessionId?: SessionId | null;
    }> = [];
    const errors: unknown[] = [];
    let resolveA!: () => void;
    let rejectB!: (reason: Error) => void;

    const coordinator = createSectionMoveCoordinator({
      execute: (sessionId, sectionId, beforeSessionId) => {
        calls.push({ sessionId, sectionId, beforeSessionId });
        if (sessionId === sid("a")) {
          return new Promise<void>((resolve) => {
            resolveA = resolve;
          });
        }
        return new Promise<void>((_resolve, reject) => {
          rejectB = reject;
        });
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    let notifications = 0;
    const stop = coordinator.movingSessionIds.subscribe(() => {
      notifications++;
    });

    const moveA1 = coordinator.move({
      sessionId: sid("a"),
      sectionId: "sec-1",
      beforeSessionId: null,
    });
    assert.equal(coordinator.isMoving(sid("a")), true);
    assert.equal(coordinator.movingSessionIds.getSnapshot().has(sid("a")), true);

    // Duplicate move for session A is skipped while in flight
    const moveA2 = await coordinator.move({
      sessionId: sid("a"),
      sectionId: "sec-2",
      beforeSessionId: null,
    });
    assert.deepEqual(moveA2, { status: "skipped-in-flight" });
    assert.equal(calls.length, 1);

    // Different session B can move concurrently
    const moveB = coordinator.move({ sessionId: sid("b"), sectionId: null });
    assert.equal(coordinator.isMoving(sid("b")), true);
    assert.equal(calls.length, 2);

    resolveA();
    assert.deepEqual(await moveA1, { status: "committed" });
    assert.equal(coordinator.isMoving(sid("a")), false);

    const failure = new Error("Owner view incomplete");
    rejectB(failure);
    const outcomeB = await moveB;
    assert.equal(outcomeB.status, "failed");
    assert.equal(coordinator.isMoving(sid("b")), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0], failure);
    assert.ok(notifications >= 4);
    stop();
  });
});
