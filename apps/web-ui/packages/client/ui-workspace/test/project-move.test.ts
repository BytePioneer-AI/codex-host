import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  WorkspaceLocalProject,
  WorkspaceMoveSessionToProjectValue,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  createProjectMoveCoordinator,
  resolveMoveProjectDialogState,
} from "../src/client/session-actions/project-move.ts";
import { SessionMoveLock } from "../src/client/session-move-lock.ts";

const sid = (value: string): SessionId => value as SessionId;

describe("move-to-project menu and dialog", () => {
  const sessionId = sid("s-1");
  const alpha: WorkspaceLocalProject = { id: "alpha", name: "A", sessionIds: [sessionId] };
  const beta: WorkspaceLocalProject = { id: "beta", name: "B", sessionIds: [], workspaceIds: [] };
  const projections = {
    nativeDiscovery: true,
    threadReference: { hostId: "local" },
    threadTreeParent: null,
    harnessIdentity: { id: "external", name: "External" },
  };
  const summary = { id: sessionId, blank: false, projectionValues: projections };
  type Input = Parameters<typeof resolveMoveProjectDialogState>[0];
  const workspace: Input["workspace"] = {
    phase: "ready",
    state: "idle",
    pinnedSessionIds: [],
    archivedSessionIds: [],
    localProjects: [alpha, beta],
  };
  const state = (change: Partial<Input> = {}, updates: Partial<Input["workspace"]> = {}) =>
    resolveMoveProjectDialogState({
      sessionId,
      summary,
      selectedTarget: beta.id,
      busy: false,
      ...change,
      workspace: { ...workspace, ...updates },
    });

  it("allows canonical local threads regardless of harness and allows a rootless destination", () => {
    assert.equal(state().eligible, true);
    assert.equal(state().canSubmit, true);
    assert.equal(state({ busy: true }).canSubmit, false);
    assert.equal(state({ selectedTarget: alpha.id }).canSubmit, false);
    assert.equal(state({}, { localProjects: [alpha] }).canSubmit, false);
    assert.equal(state({}, { localProjects: [alpha] }).eligible, true);
    assert.equal(state({}, { localProjects: [alpha] }).rowEligible, true);
  });

  it("can clear the only project but cannot clear an already projectless or unverified Thread", () => {
    const clear = { selectedTarget: "" };
    assert.equal(state(clear, { localProjects: [alpha] }).canSubmit, true);
    assert.equal(state(clear, { localProjects: [alpha] }).targetDeleted, false);
    assert.equal(state(clear, { localProjects: [beta] }).canSubmit, false);
    assert.equal(
      state(clear, { localProjects: [beta], projectlessSessionIds: [sessionId] }).canSubmit,
      false,
    );
  });

  it("requires an explicit projectless assignment or a single unambiguous owner", () => {
    assert.equal(state({}, { localProjects: [beta] }).eligible, false);
    assert.equal(state({}, { localProjects: [beta] }).rowEligible, false);
    assert.equal(
      state({}, { localProjects: [beta], projectlessSessionIds: [sessionId] }).canSubmit,
      true,
    );
    for (const updates of [
      { localProjects: [] },
      { projectlessSessionIds: [sessionId] }, // also assigned to alpha
      { localProjects: [alpha, { ...beta, sessionIds: [sessionId] }] },
      { localProjects: [alpha, { ...alpha, sessionIds: [] }, beta] },
    ]) {
      assert.equal(state({}, updates).eligible, false);
      assert.equal(state({}, updates).canSubmit, false);
    }
    for (const updates of [
      { localProjects: [alpha, { ...beta, id: " " }] },
      { localProjects: [alpha, beta, beta] },
    ]) {
      assert.equal(state({}, updates).targetDeleted, true);
      assert.equal(state({}, updates).canSubmit, false);
    }
  });

  it("rechecks the selected row and registry when an open dialog becomes stale", () => {
    for (const row of [
      undefined,
      { ...summary, id: sid("other") },
      { ...summary, blank: true },
      { ...summary, origin: "subagent" as const },
      { ...summary, parentId: sid("parent") },
      { ...summary, projectionValues: { harnessIdentity: projections.harnessIdentity } },
      { ...summary, projectionValues: { ...projections, nativeDiscovery: false } },
      { ...summary, projectionValues: { ...projections, threadTreeParent: "parent" } },
      {
        ...summary,
        projectionValues: { ...projections, threadReference: { hostId: "remote-ssh:host" } },
      },
      {
        ...summary,
        projectionValues: {
          ...projections,
          threadReference: { hostId: "local", threadId: "other" },
        },
      },
    ]) {
      assert.equal(state({ summary: row }).canSubmit, false);
    }
    assert.equal(state({}, { pinnedSessionIds: [sessionId] }).canSubmit, false);
    assert.equal(state({}, { archivedSessionIds: [sessionId] }).canSubmit, false);
    assert.equal(state({}, { state: "loading" }).canSubmit, false);
    assert.equal(state({}, { state: "error" }).canSubmit, false);
  });

  it("tracks live ownership before a choice, but never remaps a selected target", () => {
    const untouched = state({ selectedTarget: null });
    assert.equal(untouched.effectiveTarget, alpha.id);
    assert.equal(untouched.canSubmit, false);
    const reassigned = {
      localProjects: [
        { ...alpha, sessionIds: [] },
        { ...beta, sessionIds: [sessionId] },
      ],
    };
    assert.equal(state({ selectedTarget: null }, reassigned).effectiveTarget, beta.id);
    assert.equal(state({}, reassigned).canSubmit, false);
    const unassigned = state(
      { selectedTarget: null },
      { localProjects: [beta], projectlessSessionIds: [sessionId] },
    );
    assert.equal(unassigned.effectiveTarget, "");
    assert.equal(unassigned.canSubmit, false);
    for (const targets of [[alpha], [alpha, beta, beta]]) {
      const unavailable = state({}, { localProjects: targets });
      assert.equal(unavailable.effectiveTarget, beta.id);
      assert.equal(unavailable.targetDeleted, true);
      assert.equal(unavailable.canSubmit, false);
    }
  });
});

describe("createProjectMoveCoordinator", () => {
  it("enforces per-session in-flight locks, returns committed/unknown without retry, and handles failures", async () => {
    const calls: Array<{ sessionId: SessionId; projectId: string | null }> = [];
    const moveA = Promise.withResolvers<WorkspaceMoveSessionToProjectValue>();
    const moveBResult = Promise.withResolvers<WorkspaceMoveSessionToProjectValue>();

    const lock = new SessionMoveLock();
    const coordinator = createProjectMoveCoordinator({
      lock,
      execute: (sessionId, projectId) => {
        calls.push({ sessionId, projectId });
        if (sessionId === sid("a")) return moveA.promise;
        if (sessionId === sid("u")) {
          return Promise.resolve({ status: "unknown" });
        }
        return moveBResult.promise;
      },
    });

    const moveA1 = coordinator.move({ sessionId: sid("a"), projectId: "proj-beta" });
    assert.equal(coordinator.isMoving(sid("a")), true);
    assert.equal(coordinator.movingSessionIds.getSnapshot().has(sid("a")), true);
    assert.equal(lock.tryAcquire(sid("a")), false);
    assert.equal(lock.tryAcquire(sid("c")), true);
    assert.deepEqual(await coordinator.move({ sessionId: sid("c"), projectId: "proj-beta" }), {
      status: "skipped-in-flight",
    });
    lock.release(sid("c"));
    assert.equal(lock.isMoving(sid("c")), false);

    const moveA2 = await coordinator.move({ sessionId: sid("a"), projectId: "proj-gamma" });
    assert.deepEqual(moveA2, { status: "skipped-in-flight" });
    assert.equal(calls.length, 1);

    const moveB = coordinator.move({ sessionId: sid("b"), projectId: "proj-beta" });
    assert.equal(coordinator.isMoving(sid("b")), true);
    assert.equal(calls.length, 2);

    moveA.resolve({ status: "confirmed", projectId: "proj-beta" });
    assert.deepEqual(await moveA1, { status: "committed", projectId: "proj-beta" });
    assert.equal(coordinator.isMoving(sid("a")), false);

    // Unknown outcome does not treat as committed, does not auto-retry, and releases lock
    const moveU = await coordinator.move({ sessionId: sid("u"), projectId: "proj-beta" });
    assert.deepEqual(moveU, { status: "unknown" });
    assert.equal(coordinator.isMoving(sid("u")), false);
    assert.equal(calls.length, 3);

    const failure = new Error("Project unavailable");
    moveBResult.reject(failure);
    const outcomeB = await moveB;
    assert.deepEqual(outcomeB, { status: "failed", error: failure });
    assert.equal(coordinator.isMoving(sid("b")), false);
  });
});
