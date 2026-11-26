import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {
  WorkspaceThreadSection,
  WorkspaceView,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  filterSessionsByHostScope,
  filterWorkspacesByHostScope,
  type HostScopeFilterState,
} from "../src/client/rows/host-scope-filter.ts";
import {
  canCommitSectionDrop,
  createSectionMoveCoordinator,
  localReorderGapTarget,
  isSectionMovableSession,
  isSectionRowMoving,
  PINNED_THREAD_SECTION_ID,
  resolveMoveSectionDialogState,
  resolveSectionDropMove,
  resolveSectionStepMove,
  visibleCustomSectionThreadIds,
} from "../src/client/rows/section-dnd.ts";
import { GROUP_INITIAL_ROWS, sidebarWindow } from "../src/client/rows/sidebar-window.ts";
import { createWorkspaceViewStore } from "../src/client/stores.ts";
import { threadTreeOrderSource } from "../src/client/thread-tree-order.ts";
import {
  deriveFlat,
  deriveGroups,
  deriveSearchResults,
  deriveThreadForest,
  type SessionRowState,
} from "../src/client/tree.ts";

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

  it("moves back to unsectioned with the original section and no anchor", () => {
    const moveOut = resolveSectionDropMove(
      { sessionId: sid("a1"), sourceSectionId: "sec-a" },
      { kind: "unsectioned" },
      sections,
      visible,
    );
    assert.deepEqual(moveOut, {
      sessionId: sid("a1"),
      sectionId: null,
      expectedSourceSectionId: "sec-a",
    });
    assert.equal(Object.hasOwn(moveOut!, "beforeSessionId"), false);
  });

  it("ignores unsectioned-to-unsectioned", () => {
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

  it("rejects drag-out if the original custom section no longer contains the session", () => {
    const source = { sessionId: sid("a1"), sourceSectionId: "sec-a" };
    const target = { kind: "unsectioned" } as const;
    const originalWithoutSession = { id: "sec-a", name: "Alpha", threadIds: [sid("a2")] };
    const newOwner = { id: "sec-b", name: "Beta", threadIds: [sid("a1")] };

    assert.equal(resolveSectionDropMove(source, target, [originalWithoutSession], visible), null);
    assert.equal(
      resolveSectionDropMove(source, target, [originalWithoutSession, newOwner], visible),
      null,
    );
    assert.equal(resolveSectionDropMove(source, target, [newOwner], visible), null);
  });

  it("rejects drag-out from the built-in Pinned section", () => {
    assert.equal(
      resolveSectionDropMove(
        { sessionId: sid("p1"), sourceSectionId: PINNED_THREAD_SECTION_ID },
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

describe("localReorderGapTarget", () => {
  it("resolves the release position, restricted to adjacent rows in the same pinned block", () => {
    const branch = (id: string | null, pinned: boolean, top: number, bottom: number) => ({
      getAttribute: (name: string) => (name === "data-thread-branch" ? id : null),
      querySelector: (selector: string) =>
        selector === "[data-thread-pinned]"
          ? {
              getAttribute: (name: string) =>
                name === "data-thread-pinned" ? String(pinned) : null,
            }
          : null,
      getBoundingClientRect: () => ({ top, bottom }),
    });
    const container = {
      children: [
        branch("pinned", true, 60, 92),
        branch("a", false, 100, 132),
        branch("b", false, 134, 166),
        branch("c", false, 168, 200),
        branch(null, false, 202, 234),
      ],
    } as unknown as HTMLElement;
    const gap = (clientY: number, pinned = false, target: EventTarget = container) =>
      localReorderGapTarget({ target, currentTarget: container, clientY }, pinned);
    assert.deepEqual(gap(133), { id: "a", half: "after" });
    assert.deepEqual(gap(167), { id: "b", half: "after" });
    assert.equal(gap(167, false, new EventTarget()), null);
    assert.equal(gap(96), null);
    assert.equal(gap(96, true), null);
    assert.equal(gap(201), null);
    assert.equal(gap(50), null);
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
      beforeSessionId: SessionId | null | undefined;
      expectedSourceSectionId: string | undefined;
    }> = [];
    const errors: unknown[] = [];
    let resolveA!: () => void;
    let rejectB!: (reason: Error) => void;

    const coordinator = createSectionMoveCoordinator({
      execute: (sessionId, sectionId, beforeSessionId, expectedSourceSectionId) => {
        calls.push({ sessionId, sectionId, beforeSessionId, expectedSourceSectionId });
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
    const moveB = coordinator.move({
      sessionId: sid("b"),
      sectionId: null,
      expectedSourceSectionId: "sec-2",
    });
    assert.equal(coordinator.isMoving(sid("b")), true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls, [
      {
        sessionId: sid("a"),
        sectionId: "sec-1",
        beforeSessionId: null,
        expectedSourceSectionId: undefined,
      },
      {
        sessionId: sid("b"),
        sectionId: null,
        beforeSessionId: undefined,
        expectedSourceSectionId: "sec-2",
      },
    ]);

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

  it("keeps moves and other subscribers working when a subscriber throws", async (t) => {
    const failure = new Error("Owner view incomplete");
    let rejectMove = false;
    const coordinator = createSectionMoveCoordinator({
      execute: async () => {
        if (rejectMove) throw failure;
      },
    });
    const observed: SessionId[][] = [];
    t.mock.method(console, "error", () => undefined);
    coordinator.movingSessionIds.subscribe(() => {
      throw new Error("Broken subscriber");
    });
    coordinator.movingSessionIds.subscribe(() => {
      observed.push([...coordinator.movingSessionIds.getSnapshot()]);
    });
    const payload = { sessionId: sid("a"), sectionId: "sec-1" };
    assert.deepEqual(await coordinator.move(payload), { status: "committed" });
    rejectMove = true;
    assert.deepEqual(await coordinator.move(payload), { status: "failed", error: failure });
    assert.deepEqual(observed, [[payload.sessionId], [], [payload.sessionId], []]);
    assert.equal(coordinator.isMoving(payload.sessionId), false);
  });
});

describe("mixed Codex and external Harness sidebar section projection", () => {
  const harnessSummary = (
    id: string,
    harnessId: string,
    title: string,
    updatedAt: number,
  ): SessionSummary =>
    ({
      id: sid(id),
      title,
      displayTitle: title,
      cwd: "/repo/project",
      running: false,
      blank: false,
      origin: "user",
      updatedAt,
      retainedBy: {},
      projectionValues: {
        harnessIdentity: { id: harnessId, name: harnessId },
        threadReference: { hostId: "local" },
      },
    }) as SessionSummary;

  const projectLayout = (
    list: SessionListState,
    workspaces: readonly WorkspaceView[],
    sections: readonly WorkspaceThreadSection[],
    view: ReturnType<ReturnType<typeof createWorkspaceViewStore>["create"]>,
    hostScope?: HostScopeFilterState,
  ) => {
    const viewState = view.getSnapshot();
    const archivedFilter = viewState.archivedFilter ?? "default";
    const nativeSections = archivedFilter === "only" ? [] : sections;
    const rowState: SessionRowState = {
      pinnedSessionIds: [],
      archivedSessionIds: [],
      archivedFilter,
      sectionedSessionIds: new Set(nativeSections.flatMap((entry) => entry.threadIds)),
    };
    const scopedWorkspaces = hostScope
      ? filterWorkspacesByHostScope(workspaces, hostScope)
      : workspaces;
    const visibleWorkspaceIds = new Set<string>(scopedWorkspaces.map((w) => w.workspaceId));
    const order = threadTreeOrderSource(list, rowState);
    const scopedSessionIds = hostScope
      ? new Set(
          filterSessionsByHostScope(
            list.ids.map((id) => ({
              id,
              remote: list.byId[id]?.projectionValues?.remoteHost ?? undefined,
            })),
            visibleWorkspaceIds,
            workspaces,
            hostScope,
            order.rootOf,
          ).map((entry) => entry.id),
        )
      : null;
    const scopedList: SessionListState =
      scopedSessionIds === null
        ? list
        : { ...list, ids: list.ids.filter((id) => scopedSessionIds.has(id)) };
    const expandedGroups = scopedWorkspaces
      .map((w) => w.workspaceId as string)
      .filter((key) => viewState.groupExpansion[key] === true);
    const groups = deriveGroups(scopedList, scopedWorkspaces, rowState, new Map(), {
      expandedGroups,
      excludePinned: true,
    });
    const roots = new Map(
      deriveThreadForest(scopedList, rowState, new Map()).map((node) => [node.id, node]),
    );
    const sectionRows = new Map(
      nativeSections.map((entry) => [
        entry.id,
        entry.threadIds.flatMap((threadId) => {
          const node = roots.get(threadId);
          return node && !node.pinned ? [node.id] : [];
        }),
      ]),
    );
    const flatUnsectioned = deriveFlat(scopedList, scopedList.ids, rowState, new Map())
      .filter((node) => !node.pinned && !rowState.sectionedSessionIds?.has(node.id))
      .map((node) => node.id);
    return { rowState, groups, sectionRows, flatUnsectioned, scopedSessionIds };
  };

  it("keeps sectioned external and Codex rows out of projects across collapse/expand, single move, search/filter, and restart projection", () => {
    const rows = [
      harnessSummary("codex-sec", "codex", "Codex sectioned", 500),
      harnessSummary("ext-a", "pi-native", "External Alpha", 400),
      harnessSummary("ext-b", "claude-code", "External Beta", 300),
      harnessSummary("ext-proj", "pi-native", "External Project", 200),
      harnessSummary("codex-older", "codex", "Codex Older", 100),
    ];
    const list: SessionListState = {
      ids: rows.map((r) => r.id),
      byId: Object.fromEntries(rows.map((r) => [r.id, r])),
      phase: "ready",
      projectionsBySession: {},
    };
    const localWorkspace: WorkspaceView = {
      workspaceId: "ws-local" as WorkspaceView["workspaceId"],
      path: "/repo/project",
      title: "Project",
      sessionIds: rows.map((r) => r.id),
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const remoteWorkspace: WorkspaceView = {
      workspaceId: "remote-workspace:p1:ws" as WorkspaceView["workspaceId"],
      path: "/remote/project",
      title: "Remote",
      sessionIds: [],
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      remote: { hostId: "remote-peer:p1", displayName: "Peer", state: "connected" },
    };
    let sections: readonly WorkspaceThreadSection[] = [
      { id: "sec-work", name: "Work", threadIds: [sid("codex-sec"), sid("ext-a"), sid("ext-b")] },
    ];

    const view = createWorkspaceViewStore().create();
    view.actions.setGroupExpanded(localWorkspace.workspaceId, true);

    // Collapse then expand project: sectioned external rows never move back into the project.
    view.actions.setGroupExpanded(localWorkspace.workspaceId, false);
    assert.deepEqual(
      projectLayout(list, [localWorkspace], sections, view).groups.find(
        (g) => g.key === localWorkspace.workspaceId,
      )?.sessions,
      [],
    );
    view.actions.setGroupExpanded(localWorkspace.workspaceId, true);
    const expanded = projectLayout(list, [localWorkspace], sections, view);
    assert.deepEqual(expanded.sectionRows.get("sec-work"), [
      sid("codex-sec"),
      sid("ext-a"),
      sid("ext-b"),
    ]);
    const expandedProjectIds = sidebarWindow(
      expanded.groups.find((g) => g.key === localWorkspace.workspaceId)!.sessions,
      GROUP_INITIAL_ROWS,
    ).rows.map((n) => n.id);
    assert.deepEqual(expandedProjectIds, [sid("ext-proj"), sid("codex-older")]);
    assert.deepEqual(expanded.flatUnsectioned, [sid("ext-proj"), sid("codex-older")]);

    // Move one external session within the section; authoritative update preserves all section members.
    const movePayload = resolveSectionDropMove(
      { sessionId: sid("ext-a"), sourceSectionId: "sec-work" },
      {
        kind: "section-row",
        sectionId: "sec-work",
        targetSessionId: sid("codex-sec"),
        half: "before",
      },
      sections,
    );
    assert.deepEqual(movePayload, {
      sessionId: sid("ext-a"),
      sectionId: "sec-work",
      beforeSessionId: sid("codex-sec"),
    });
    sections = [
      { id: "sec-work", name: "Work", threadIds: [sid("ext-a"), sid("codex-sec"), sid("ext-b")] },
    ];
    const afterMove = projectLayout(list, [localWorkspace], sections, view);
    assert.deepEqual(afterMove.sectionRows.get("sec-work"), [
      sid("ext-a"),
      sid("codex-sec"),
      sid("ext-b"),
    ]);
    assert.deepEqual(
      afterMove.groups.find((g) => g.key === localWorkspace.workspaceId)?.sessions.map((n) => n.id),
      [sid("ext-proj"), sid("codex-older")],
    );

    // Search + host scope filtering + archived filter toggle preserve sectionedSessionIds.
    const search = deriveSearchResults(
      list,
      [localWorkspace],
      "External",
      [],
      "default",
      new Map(),
      { items: [], hasMore: false },
      20,
    );
    assert.deepEqual(
      search.items.map((item) => item.id),
      [sid("ext-a"), sid("ext-b"), sid("ext-proj")],
    );
    const remoteFiltered = projectLayout(list, [localWorkspace, remoteWorkspace], sections, view, {
      selectedHost: "remote-peer:p1",
      perHost: {},
    });
    assert.deepEqual(remoteFiltered.sectionRows.get("sec-work"), []);
    assert.deepEqual(
      remoteFiltered.rowState.sectionedSessionIds,
      new Set([sid("ext-a"), sid("codex-sec"), sid("ext-b")]),
    );
    assert.deepEqual(
      visibleCustomSectionThreadIds(sections[0]!, {
        byId: list.byId,
        pinnedSessionIds: [],
        archivedSessionIds: [],
        archivedFilter: "default",
        visibleSessionIds: remoteFiltered.scopedSessionIds,
      }),
      [],
    );
    view.actions.setArchivedFilter("only");
    assert.equal(projectLayout(list, [localWorkspace], sections, view).sectionRows.size, 0);
    view.actions.setArchivedFilter("default");

    // Restart projection with a fresh view store keeps both external members in the section.
    const restartedView = createWorkspaceViewStore().create();
    restartedView.actions.setGroupExpanded(localWorkspace.workspaceId, true);
    const restarted = projectLayout(
      list,
      [localWorkspace, remoteWorkspace],
      sections,
      restartedView,
      { selectedHost: "all", perHost: {} },
    );
    assert.deepEqual(restarted.sectionRows.get("sec-work"), [
      sid("ext-a"),
      sid("codex-sec"),
      sid("ext-b"),
    ]);
    assert.deepEqual(
      restarted.groups.find((g) => g.key === localWorkspace.workspaceId)?.sessions.map((n) => n.id),
      [sid("ext-proj"), sid("codex-older")],
    );
  });
});
