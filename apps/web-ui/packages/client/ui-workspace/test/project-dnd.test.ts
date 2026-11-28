import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
  WorkspaceId,
  WorkspaceLocalProject,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  buildWorkspaceLocalProjectMap,
  isProjectDropTargetRow,
  resolveProjectDragSource,
  resolveProjectDropMove,
  resolveProjectDropTarget,
  type ProjectDragInput,
} from "../src/client/rows/project-dnd.ts";

const sessionId = "s1" as SessionId;
const a = "workspace-a" as WorkspaceId;
const b = "workspace-b" as WorkspaceId;
const c = "workspace-c" as WorkspaceId;
const alpha: WorkspaceLocalProject = {
  id: "alpha",
  name: "A",
  sessionIds: [sessionId],
  workspaceIds: [a],
};
const beta: WorkspaceLocalProject = {
  id: "beta",
  name: "B",
  sessionIds: [],
  workspaceIds: [b],
};
const gamma: WorkspaceLocalProject = {
  id: "gamma",
  name: "C",
  sessionIds: [],
  workspaceIds: [c],
};

function input(projects: WorkspaceLocalProject[] = [alpha, beta, gamma]): ProjectDragInput {
  return {
    sessionId,
    sourceKind: "project",
    sourceWorkspaceId: a,
    workspaceProjectMap: buildWorkspaceLocalProjectMap(projects),
    workspace: {
      phase: "ready",
      state: "idle",
      pinnedSessionIds: [],
      archivedSessionIds: [],
      localProjects: projects,
    },
    summary: {
      id: sessionId,
      blank: false,
      projectionValues: {
        nativeDiscovery: true,
        threadTreeParent: null,
        threadReference: { hostId: "local" },
        harnessIdentity: { id: "external", name: "External" },
      },
    },
    busy: false,
  };
}

function gesture(live = input()) {
  const source = resolveProjectDragSource(live);
  assert.ok(source);
  const drop = { source, live, targetWorkspaceId: b };
  const expectedTarget = resolveProjectDropTarget(drop);
  assert.deepEqual(expectedTarget, { workspaceId: b, projectId: "beta" });
  return { ...drop, expectedTarget };
}

describe("sidebar project drag", () => {
  it("accepts a canonical target row in the only local project without making it draggable", () => {
    const live = input([alpha]);
    assert.equal(isProjectDropTargetRow(live), true);
    assert.equal(resolveProjectDragSource(live), null);
    for (const change of [
      { sourceWorkspaceId: b },
      { busy: true },
      { summary: undefined },
      { workspace: { ...live.workspace, archivedSessionIds: [sessionId] } },
    ]) {
      assert.equal(isProjectDropTargetRow({ ...live, ...change }), false);
    }
  });

  it("requires a unique native project matching the regular workspace row", () => {
    const live = input();
    assert.equal(resolveProjectDragSource(live)?.sourceProjectId, "alpha");
    for (const invalid of [
      { ...live, sourceWorkspaceId: "web-only" as WorkspaceId },
      { ...live, sourceWorkspaceId: b },
      input([alpha, beta, { ...gamma, workspaceIds: [a, c] }]),
      input([alpha, beta, { ...alpha, workspaceIds: [], sessionIds: [] }]),
      input([alpha, { ...beta, workspaceIds: [] }]),
    ])
      assert.equal(resolveProjectDragSource(invalid), null);
  });

  it("accepts Recents with assigned or explicitly projectless membership, never unknown", () => {
    const recents = { ...input(), sourceKind: "recents" as const, sourceWorkspaceId: null };
    assert.equal(resolveProjectDragSource(recents)?.sourceProjectId, "alpha");
    const absent = { ...input([beta]), sourceKind: "recents" as const, sourceWorkspaceId: null };
    assert.equal(resolveProjectDragSource(absent), null);
    const explicit = {
      ...absent,
      workspace: { ...absent.workspace, projectlessSessionIds: [sessionId] },
    };
    assert.equal(resolveProjectDragSource(explicit)?.sourceProjectId, null);
    assert.deepEqual(resolveProjectDropMove(gesture(explicit)), { sessionId, projectId: "beta" });
    assert.equal(resolveProjectDropMove({ ...gesture(recents), live: explicit }), null);
  });

  it("rechecks source row, authority, group, and shared placement lock at release", () => {
    const drop = gesture();
    const { live } = drop;
    for (const invalid of [
      { ...live, summary: undefined },
      { ...live, busy: true },
      { ...live, workspace: { ...live.workspace, pinnedSessionIds: [sessionId] } },
      { ...live, sourceWorkspaceId: c },
      input([{ ...alpha, workspaceIds: [] }, beta, gamma]),
      input([{ ...alpha, workspaceIds: [c] }, beta, { ...gamma, workspaceIds: [a] }]),
      input([{ ...alpha, sessionIds: [] }, beta, { ...gamma, sessionIds: [sessionId] }]),
      input([alpha, beta, { ...gamma, sessionIds: [sessionId] }]),
    ]) {
      assert.equal(resolveProjectDropTarget({ ...drop, live: invalid }), null);
      assert.equal(resolveProjectDropMove({ ...drop, live: invalid }), null);
    }
  });

  it("requires the same unique live target as the hovered group", () => {
    const drop = gesture();
    for (const change of [
      { targetWorkspaceId: undefined },
      { targetWorkspaceId: "remote-workspace" as WorkspaceId },
      { expectedTarget: null },
      { targetWorkspaceId: a },
      { targetWorkspaceId: c },
      { live: input([alpha, gamma]) },
      { live: input([alpha, { ...beta, workspaceIds: [c] }, { ...gamma, workspaceIds: [b] }]) },
      { live: input([alpha, beta, { ...gamma, workspaceIds: [b] }]) },
      { live: input([alpha, beta, { ...beta, workspaceIds: [c] }]) },
    ])
      assert.equal(resolveProjectDropMove({ ...drop, ...change }), null);
  });

  it("withdraws a row target when the row is gone, busy, or no longer in that project", () => {
    const targetId = "s2" as SessionId;
    const live = input([alpha, { ...beta, sessionIds: [targetId] }, gamma]);
    const drop = gesture(live);
    const targetRow: ProjectDragInput = {
      ...live,
      sessionId: targetId,
      sourceWorkspaceId: b,
      summary: live.summary && { ...live.summary, id: targetId },
    };
    assert.deepEqual(resolveProjectDropTarget({ ...drop, targetRow }), drop.expectedTarget);
    for (const invalid of [
      null,
      { ...targetRow, busy: true },
      { ...targetRow, sourceWorkspaceId: c },
    ]) {
      assert.equal(resolveProjectDropTarget({ ...drop, targetRow: invalid }), null);
      assert.equal(resolveProjectDropMove({ ...drop, targetRow: invalid }), null);
    }
    assert.deepEqual(resolveProjectDropTarget(drop), drop.expectedTarget);
  });

  it("emits only the session and project IDs and rejects copy releases", () => {
    const drop = gesture();
    assert.deepEqual(resolveProjectDropMove(drop), { sessionId, projectId: "beta" });
    assert.equal(resolveProjectDropMove({ ...drop, dropEffect: "copy" }), null);
  });
});
