import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  threadDropRegion,
  threadDropTargets,
  threadGroupDrop,
} from "../src/client/rows/thread-drop.ts";

function row(id: string, parent: string | null = null): SessionSummary {
  return {
    id: SessionId(id),
    title: id,
    displayTitle: id,
    blank: false,
    running: false,
    retainedBy: {},
    updatedAt: 1,
    projectionValues: { threadTreeParent: parent, threadReference: { hostId: "local" } },
  };
}
function catalog(...rows: SessionSummary[]): SessionListState {
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    phase: "ready",
    projectionsBySession: {},
  };
}

it("reserves the outer quarters for manual ordering and the center for placement", () => {
  const rect = { top: 100, height: 40 };
  for (const y of [100, 109.99]) assert.equal(threadDropRegion(y, rect, true), "before");
  for (const y of [110, 120, 129.99]) assert.equal(threadDropRegion(y, rect, true), "under");
  for (const y of [130, 140]) assert.equal(threadDropRegion(y, rect, true), "after");
  for (const y of [100, 110, 130, 140]) assert.equal(threadDropRegion(y, rect, false), "under");
  assert.equal(threadDropRegion(100, { top: 100, height: 0 }, true), "under");
});

it("uses catalog placement rules for self, descendants, current parent, archive, remote, draft and Subagent", () => {
  const remote = row("remote");
  remote.projectionValues = {
    ...remote.projectionValues,
    remoteHost: { hostId: "away", displayName: "Away", state: "connected" },
  };
  const list = catalog(
    row("parent"),
    row("source", "parent"),
    row("child", "source"),
    row("grandchild", "child"),
    row("archived"),
    remote,
    { ...row("draft"), blank: true },
    { ...row("worker"), origin: "subagent" },
    row("target"),
  );
  assert.deepEqual([...threadDropTargets(list, "source", ["archived"])], ["target"]);
  for (const id of ["archived", "remote", "draft", "worker", "missing"])
    assert.equal(threadDropTargets(list, id, ["archived"]).size, 0);
});

it("only the owning display group detaches lineage; a foreign folder changes membership only", () => {
  assert.equal(threadGroupDrop("own", "own", true, true), "top");
  assert.equal(threadGroupDrop("", "", true, false), "top");
  assert.equal(threadGroupDrop("own", "own", false, true), null);
  assert.equal(threadGroupDrop("own", "other", true, true), "folder");
  assert.equal(threadGroupDrop("own", "other", false, true), "folder");
  assert.equal(threadGroupDrop("own", "remote", true, false), null);
  assert.equal(threadGroupDrop("own", "recent", true, false), null);
});
