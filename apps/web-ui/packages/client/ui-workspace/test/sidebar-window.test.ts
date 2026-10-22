import assert from "node:assert/strict";
import { it } from "node:test";
import {
  sidebarWindow,
  WORKSPACE_INITIAL_ROWS,
  workspaceWindow,
} from "../src/client/rows/sidebar-window.ts";

const rows = () =>
  Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    blank: false,
    pinned: false,
    running: false,
    runningSubagentCount: 0,
  }));

it("keeps the current and search target visible without expanding all intervening history", () => {
  const result = sidebarWindow(rows(), 5, "38", "39");
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["0", "1", "2", "3", "4", "38", "39"],
  );
  assert.equal(result.hiddenCount, 33);
});
it("selecting within the initial window does not reveal another row or duplicate the selection", () => {
  assert.equal(sidebarWindow(rows(), 5, "2", "2").rows.length, 5);
});
it("retains pinned, provisional and active conversations outside the ordinary quota", () => {
  const source = rows();
  const pinned = source[10],
    blank = source[11],
    running = source[12],
    parent = source[13];
  assert.ok(pinned && blank && running && parent);
  pinned.pinned = true;
  blank.blank = true;
  running.running = true;
  parent.runningSubagentCount = 1;
  const result = sidebarWindow(source, 5);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["0", "1", "2", "3", "4", "10", "11", "12", "13"],
  );
  assert.equal(result.hiddenCount, 31);
});
it("extends a presentation window by ten without mutating the catalog order", () => {
  const source = rows();
  const before = structuredClone(source);
  assert.equal(sidebarWindow(source, 15).rows.length, 15);
  assert.deepEqual(source, before);
  assert.equal(sidebarWindow(source, 50).hiddenCount, 0);
  assert.deepEqual(sidebarWindow([], 5), { rows: [], hiddenCount: 0 });
});

const workspaces = () => ["a", "b", "c", "d", "e", "f", "g"].map((key) => ({ key }));

it("shows the leading Workspaces and hides the rest by default", () => {
  const result = workspaceWindow(workspaces(), WORKSPACE_INITIAL_ROWS, new Set());
  assert.deepEqual(
    result.rows.map((row) => row.key),
    ["a", "b", "c", "d", "e"],
  );
  assert.equal(result.hiddenCount, 2);
});
it("keeps a Workspace that must stay reachable in place without spending the quota", () => {
  const result = workspaceWindow(workspaces(), WORKSPACE_INITIAL_ROWS, new Set(["g"]));
  assert.deepEqual(
    result.rows.map((row) => row.key),
    ["a", "b", "c", "d", "e", "g"],
  );
  assert.equal(result.hiddenCount, 1);
});
it("leaves a short Workspace list completely visible", () => {
  assert.deepEqual(workspaceWindow(workspaces().slice(0, 3), WORKSPACE_INITIAL_ROWS, new Set()), {
    rows: workspaces().slice(0, 3),
    hiddenCount: 0,
  });
  assert.deepEqual(workspaceWindow([], WORKSPACE_INITIAL_ROWS, new Set()), {
    rows: [],
    hiddenCount: 0,
  });
});
