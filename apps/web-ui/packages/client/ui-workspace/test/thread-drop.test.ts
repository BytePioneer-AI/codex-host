import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import {
  threadDropDwell,
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

it("uses half rows for insertion, never attaching without a confirmed dwell", () => {
  const rect = { top: 100, height: 40 };
  for (const y of [100, 110, 119.99]) assert.equal(threadDropRegion(y, rect, true), "before");
  for (const y of [120, 129, 140]) assert.equal(threadDropRegion(y, rect, true), "after");
  for (const y of [100, 110, 130, 140]) assert.equal(threadDropRegion(y, rect, false), "sibling");
  assert.equal(threadDropRegion(100, { top: 100, height: 0 }, true), "sibling");
});

it("confirms after 400ms in the middle half, keeps drifting inside the row and resets at the edges", () => {
  const rect = { top: 100, height: 40 };
  const point = { id: "target", x: 100, y: 120, now: 1000 };
  const dwell = threadDropDwell(null, point, rect);
  assert.ok(dwell);
  assert.equal(threadDropRegion(120, rect, true, dwell, 1399), "after");
  for (const manual of [true, false])
    assert.equal(threadDropRegion(120, rect, manual, dwell, 1400), "under");
  assert.equal(threadDropDwell(dwell, { ...point, x: 160, now: 1200 }, rect), dwell);
  assert.equal(threadDropDwell(dwell, { ...point, y: 109.9, now: 1200 }, rect), null);
  assert.equal(threadDropDwell(dwell, { ...point, y: 109.9, now: 1400 }, rect), dwell);
  assert.equal(threadDropDwell(dwell, { ...point, y: 136.1, now: 1400 }, rect), null);
  assert.equal(threadDropDwell(dwell, { ...point, id: "other", now: 1600 }, rect)?.since, 1600);
  assert.equal(threadDropDwell(dwell, point, { top: 100, height: 0 }), null);
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
