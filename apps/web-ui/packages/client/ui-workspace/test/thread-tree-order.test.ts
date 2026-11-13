import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import {
  threadChildOrder,
  threadInsertOrder,
  orderedThreadChildren,
  threadTreeOrderSource,
} from "../src/client/thread-tree-order.ts";
import { deriveFlat, type SessionRowState } from "../src/client/tree.ts";
import { visibleThreadRows } from "../src/client/thread-tree.ts";
import { createWorkspaceViewStore } from "../src/client/stores.ts";
import { pinOrderSource } from "../src/client/pin-order.ts";

const id = SessionId;
const state: SessionRowState = {
  pinnedSessionIds: [],
  archivedSessionIds: [],
  archivedFilter: "default",
};
function catalog(): SessionListState {
  const rows: SessionSummary[] = [
    ["a", null, 1],
    ["b", "a", 3],
    ["c", "a", 4],
    ["deep", "b", 5],
    ["d", null, 2],
  ].map(([key, parent, updatedAt]) => ({
    id: id(String(key)),
    title: String(key),
    displayTitle: String(key),
    updatedAt: Number(updatedAt),
    blank: false,
    running: false,
    retainedBy: {},
    projectionValues: {
      threadTreeParent: parent === null ? null : String(parent),
      threadReference: { hostId: "local" },
    },
  }));
  return {
    ids: rows.map((row) => row.id),
    byId: Object.fromEntries(rows.map((row) => [row.id, row])),
    phase: "ready",
    projectionsBySession: {},
  };
}

it("reconciles new children first and ignores departed, unknown and duplicate saved slots", () => {
  const list = catalog();
  assert.deepEqual(threadChildOrder([id("b"), id("c")], ["b", "departed", "b"], list.byId), [
    "c",
    "b",
  ]);
  assert.deepEqual(threadChildOrder([id("b"), id("c")], undefined, list.byId), ["c", "b"]);
  assert.deepEqual(threadChildOrder([id("b"), id("c")], ["b", "c"], list.byId), ["b", "c"]);
});

it("independently orders every level without changing recency ordering or input trees", () => {
  const list = catalog();
  const roots = deriveFlat(list, [id("d"), id("a")], state, new Map());
  const before = structuredClone(roots);
  assert.deepEqual(threadTreeOrderSource(list, state).childMembers, {
    "thread:a": ["c", "b"],
    "thread:b": ["deep"],
  });
  const ordered = visibleThreadRows(roots, { a: true, b: true }, (node) =>
    orderedThreadChildren(node, { "thread:a": ["b", "c"] }, list.byId),
  );
  assert.deepEqual(
    ordered.map((row) => row.id),
    ["d", "a", "b", "deep", "c"],
  );
  assert.deepEqual(
    visibleThreadRows(roots, { a: true, b: true }).map((row) => row.id),
    ["d", "a", "c", "b", "deep"],
  );
  assert.deepEqual(roots, before);
});

it("inserts cross-layer sources into the destination only, including empty layers", () => {
  assert.deepEqual(threadInsertOrder([id("a"), id("d")], id("deep"), id("a"), "after"), [
    "a",
    "deep",
    "d",
  ]);
  assert.deepEqual(threadInsertOrder([id("c"), id("b")], id("b"), id("c")), ["b", "c"]);
  assert.deepEqual(threadInsertOrder([], id("b")), ["b"]);
});

it("retains child containers across workspace cleanup and stores a destination order alongside placement", () => {
  const list = catalog();
  const source = pinOrderSource([], list, state);
  const view = createWorkspaceViewStore().create();
  view.actions.setOrderBy("manual", { "thread:a": ["c", "b"] }, source);
  view.actions.setSessionOrder("thread:a", ["b", "c"], {}, source);
  view.actions.retainAccountKeys(["", "__flat_session_order__"]);
  assert.deepEqual(view.getSnapshot().sessionOrderByAccount["thread:a"], ["b", "c"]);
  const next = threadInsertOrder([id("a"), id("d")], id("deep"), id("a"), "after");
  view.actions.setSessionOrder(
    "__flat_session_order__",
    next,
    {},
    { ...source, members: { ...source.members, __flat_session_order__: next } },
  );
  assert.deepEqual(view.getSnapshot().sessionOrderByAccount.__flat_session_order__, [
    "a",
    "deep",
    "d",
  ]);
  assert.deepEqual(view.getSnapshot().sessionOrderByAccount["thread:a"], ["b", "c"]);
});
