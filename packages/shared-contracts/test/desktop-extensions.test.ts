import { expect, test } from "vitest";
import {
  parseDesktopExtensionManifest,
  resolveDesktopExtensionSlots,
  threadTreeSnapshotSchema,
  type DesktopExtensionManifest,
} from "../src/index.js";

const manifest = {
  manifestVersion: 1,
  id: "thread-tree",
  name: "Thread Tree",
  version: "0.1.0",
  desktopApi: 1,
  desktop: { script: "desktop.js" },
  slots: ["sidebar.thread-layout", "sidebar.thread-badge"],
} satisfies DesktopExtensionManifest;

test.each([
  [{}, "valid"],
  [{ unexpected: true }, "invalid"],
  [{ backend: "backend.mjs" }, "incompatible"],
  [{ desktopApi: 2, futureField: true }, "incompatible"],
  [{ slots: ["composer"] }, "invalid"],
  [{ desktop: { script: "../desktop.js" } }, "invalid"],
])("classifies desktop manifest with %j as %s", (patch, state) => {
  expect(parseDesktopExtensionManifest({ ...manifest, ...patch }).state).toBe(state);
});

test.each([
  [["thread-tree", "badge", "layout"], ["thread-tree"], "badge", "thread-tree"],
  [["badge", "thread-tree", "layout"], ["badge", "layout"], "thread-tree", "badge"],
])("resolves all declared slots atomically in enabled order %j", (order, active, loser, owner) => {
  const result = resolveDesktopExtensionSlots(order, [
    manifest,
    { id: "badge", slots: ["sidebar.thread-badge"] },
    { id: "layout", slots: ["sidebar.thread-layout"] },
  ]);
  expect(result.active).toEqual(active);
  expect(result.conflicts.get(loser)).toBe(owner);
});

test("rejects snapshots with dangling edges", () => {
  const snapshot = {
    revision: 1,
    parents: { child: "parent" },
    nodes: { child: { harnessId: "codex", status: "unknown", archived: false } },
    truncated: true,
  };
  expect(threadTreeSnapshotSchema.safeParse(snapshot).success).toBe(false);
  expect(threadTreeSnapshotSchema.safeParse({ ...snapshot, parents: {} }).success).toBe(true);
});
