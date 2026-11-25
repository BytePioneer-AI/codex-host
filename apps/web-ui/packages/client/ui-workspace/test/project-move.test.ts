import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  WorkspaceLocalProject,
  WorkspaceMoveSessionToProjectValue,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  createProjectMoveCoordinator,
  findSessionLocalProject,
  isProjectMovableSession,
  resolveMoveProjectDialogState,
} from "../src/client/session-actions/project-move.ts";

const sid = (value: string): SessionId => value as SessionId;

describe("isProjectMovableSession", () => {
  const twoProjects: readonly WorkspaceLocalProject[] = [
    { id: "proj-alpha", name: "Alpha", sessionIds: [sid("s-1")] },
    { id: "proj-beta", name: "Beta", sessionIds: [] },
  ];
  const singleProject: readonly WorkspaceLocalProject[] = [
    { id: "proj-alpha", name: "Alpha", sessionIds: [sid("s-1")] },
  ];
  const nativeThreadIds = new Set([sid("s-1"), sid("s-unassigned"), sid("s-pinned")]);

  it("allows local native top-level active sessions including pinned/sectioned when another target exists", () => {
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-1"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: twoProjects,
      }),
      true,
    );
    // Unassigned native session with 1 existing local native project has a valid target
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-unassigned"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: singleProject,
      }),
      true,
    );
    // Pinned sessions remain eligible (moving project never changes pin or section state)
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-pinned"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: twoProjects,
      }),
      true,
    );
  });

  it("hides when no target local native project exists or RPC is unavailable", () => {
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-1"),
        canMoveProject: false,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: twoProjects,
      }),
      false,
    );
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-1"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: [],
      }),
      false,
    );
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-1"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: undefined,
      }),
      false,
    );
    // Only 1 local project and session is already in it -> no movable destination
    assert.equal(
      isProjectMovableSession({
        sessionId: sid("s-1"),
        canMoveProject: true,
        nativeThreadIds,
        archivedSessionIds: [],
        localProjects: singleProject,
      }),
      false,
    );
  });

  it("hides for draft, subagent, delegated child, remote, archived, and non-native sessions", () => {
    const base = {
      sessionId: sid("s-1"),
      canMoveProject: true,
      nativeThreadIds,
      archivedSessionIds: [] as readonly SessionId[],
      localProjects: twoProjects,
    };
    assert.equal(isProjectMovableSession({ ...base, sessionId: sid("non-native") }), false);
    assert.equal(isProjectMovableSession({ ...base, blank: true }), false);
    assert.equal(isProjectMovableSession({ ...base, subagent: true }), false);
    assert.equal(isProjectMovableSession({ ...base, threadTreeChild: true }), false);
    assert.equal(isProjectMovableSession({ ...base, threadTreeParent: "parent-1" }), false);
    assert.equal(isProjectMovableSession({ ...base, remote: true }), false);
    assert.equal(isProjectMovableSession({ ...base, archived: true }), false);
    assert.equal(isProjectMovableSession({ ...base, archivedSessionIds: [sid("s-1")] }), false);
  });
});

describe("resolveMoveProjectDialogState", () => {
  const initial: readonly WorkspaceLocalProject[] = [
    { id: "proj-alpha", name: "Alpha", sessionIds: [sid("s-1")] },
    { id: "proj-beta", name: "Beta", sessionIds: [] },
  ];

  it("tracks live project ownership before selection and preserves user choice across updates", () => {
    assert.equal(findSessionLocalProject(sid("s-1"), initial)?.id, "proj-alpha");

    const untouched = resolveMoveProjectDialogState({
      sessionId: sid("s-1"),
      projects: initial,
      selectedTarget: null,
      busy: false,
    });
    assert.equal(untouched.currentProjectId, "proj-alpha");
    assert.equal(untouched.effectiveTarget, "proj-alpha");
    assert.equal(untouched.targetDeleted, false);
    assert.equal(untouched.canSubmit, false);

    // Another client moves s-1 before user chooses: follows live owner and stays disabled
    const movedExternally = resolveMoveProjectDialogState({
      sessionId: sid("s-1"),
      projects: [
        { id: "proj-alpha", name: "Alpha", sessionIds: [] },
        { id: "proj-beta", name: "Beta", sessionIds: [sid("s-1")] },
      ],
      selectedTarget: null,
      busy: false,
    });
    assert.equal(movedExternally.currentProjectId, "proj-beta");
    assert.equal(movedExternally.effectiveTarget, "proj-beta");
    assert.equal(movedExternally.canSubmit, false);

    // Unassigned session starts at "" with submit disabled until user picks an existing project
    const unassigned = resolveMoveProjectDialogState({
      sessionId: sid("s-unassigned"),
      projects: initial,
      selectedTarget: null,
      busy: false,
    });
    assert.equal(unassigned.currentProjectId, "");
    assert.equal(unassigned.effectiveTarget, "");
    assert.equal(unassigned.targetDeleted, false);
    assert.equal(unassigned.canSubmit, false);

    // User picks proj-beta while s-1 is in proj-alpha
    const picked = resolveMoveProjectDialogState({
      sessionId: sid("s-1"),
      projects: initial,
      selectedTarget: "proj-beta",
      busy: false,
    });
    assert.equal(picked.effectiveTarget, "proj-beta");
    assert.equal(picked.targetDeleted, false);
    assert.equal(picked.canSubmit, true);

    // Busy disables submit
    assert.equal(
      resolveMoveProjectDialogState({
        sessionId: sid("s-1"),
        projects: initial,
        selectedTarget: "proj-beta",
        busy: true,
      }).canSubmit,
      false,
    );

    // Selected project deleted while dialog is open: marks targetDeleted and blocks submit without auto-switching
    const deleted = resolveMoveProjectDialogState({
      sessionId: sid("s-1"),
      projects: [
        { id: "proj-alpha", name: "Alpha", sessionIds: [sid("s-1")] },
        { id: "proj-gamma", name: "Gamma", sessionIds: [] },
      ],
      selectedTarget: "proj-beta",
      busy: false,
    });
    assert.equal(deleted.effectiveTarget, "proj-beta");
    assert.equal(deleted.targetDeleted, true);
    assert.equal(deleted.canSubmit, false);

    // If another client moves s-1 into proj-beta after user picked it, submit becomes disabled
    const alreadyThere = resolveMoveProjectDialogState({
      sessionId: sid("s-1"),
      projects: [
        { id: "proj-alpha", name: "Alpha", sessionIds: [] },
        { id: "proj-beta", name: "Beta", sessionIds: [sid("s-1")] },
      ],
      selectedTarget: "proj-beta",
      busy: false,
    });
    assert.equal(alreadyThere.targetDeleted, false);
    assert.equal(alreadyThere.canSubmit, false);
  });
});

describe("createProjectMoveCoordinator", () => {
  it("enforces per-session in-flight locks, returns committed/unknown without retry, and handles failures", async () => {
    const calls: Array<{ sessionId: SessionId; projectId: string }> = [];
    let resolveA!: (value: WorkspaceMoveSessionToProjectValue) => void;
    let rejectB!: (reason: Error) => void;

    const coordinator = createProjectMoveCoordinator({
      execute: (sessionId, projectId) => {
        calls.push({ sessionId, projectId });
        if (sessionId === sid("a")) {
          return new Promise<WorkspaceMoveSessionToProjectValue>((resolve) => {
            resolveA = resolve;
          });
        }
        if (sessionId === sid("u")) {
          return Promise.resolve({ status: "unknown" });
        }
        return new Promise<WorkspaceMoveSessionToProjectValue>((_resolve, reject) => {
          rejectB = reject;
        });
      },
    });

    const moveA1 = coordinator.move({ sessionId: sid("a"), projectId: "proj-beta" });
    assert.equal(coordinator.isMoving(sid("a")), true);
    assert.equal(coordinator.movingSessionIds.getSnapshot().has(sid("a")), true);

    const moveA2 = await coordinator.move({ sessionId: sid("a"), projectId: "proj-gamma" });
    assert.deepEqual(moveA2, { status: "skipped-in-flight" });
    assert.equal(calls.length, 1);

    const moveB = coordinator.move(
      { sessionId: sid("b"), projectId: "proj-beta" },
      { notifyOnError: false },
    );
    assert.equal(coordinator.isMoving(sid("b")), true);
    assert.equal(calls.length, 2);

    resolveA({ status: "confirmed", projectId: "proj-beta" });
    assert.deepEqual(await moveA1, { status: "committed", projectId: "proj-beta" });
    assert.equal(coordinator.isMoving(sid("a")), false);

    // Unknown outcome does not treat as committed, does not auto-retry, and releases lock
    const moveU = await coordinator.move({ sessionId: sid("u"), projectId: "proj-beta" });
    assert.deepEqual(moveU, { status: "unknown" });
    assert.equal(coordinator.isMoving(sid("u")), false);
    assert.equal(calls.length, 3);

    const failure = new Error("Project unavailable");
    rejectB(failure);
    const outcomeB = await moveB;
    assert.equal(outcomeB.status, "failed");
    assert.equal(coordinator.isMoving(sid("b")), false);
  });
});
