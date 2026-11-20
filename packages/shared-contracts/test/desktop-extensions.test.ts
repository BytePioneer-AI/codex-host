import { expect, test } from "vitest";
import {
  parseDesktopExtensionManifest,
  resolveDesktopExtensionSlots,
  resolveLocalizedExtensionText,
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

const bilingualName = { en: "Thread Tree", "zh-CN": "委派树" };

test.each([
  [{}, "valid"],
  [{ name: bilingualName, description: { en: "Groups delegated Threads" } }, "valid"],
  [{ name: "   " }, "invalid"],
  [{ name: "a".repeat(129) }, "invalid"],
  [{ name: { en: "Tree" } }, "invalid"],
  [{ name: { "zh-CN": "树" } }, "invalid"],
  [{ name: { ...bilingualName, "zh-CN": "   " } }, "invalid"],
  [{ name: { ...bilingualName, en: "a".repeat(129) } }, "invalid"],
  [{ name: { ...bilingualName, fr: "Arbre" } }, "invalid"],
  [{ categories: [] }, "valid"],
  [
    { categories: ["sidebar", "composer", "conversation", "appearance", "tools", "workflow"] },
    "valid",
  ],
  [{ categories: ["sidebar", "sidebar"] }, "invalid"],
  [{ categories: ["sidebar.thread-layout"] }, "invalid"],
  [{ unexpected: true }, "invalid"],
  [{ backend: "backend.mjs" }, "incompatible"],
  [{ name: bilingualName, desktopApi: 2, futureField: true }, "incompatible"],
  [{ slots: ["composer"] }, "invalid"],
  [{ desktop: { script: "../desktop.js" } }, "invalid"],
])("classifies desktop manifest with %j as %s", (patch, state) => {
  expect(parseDesktopExtensionManifest({ ...manifest, ...patch }).state).toBe(state);
});

test.each([
  ["  Thread Tree  ", "Thread Tree"],
  [{ en: "  Thread Tree  ", "zh-CN": "  委派树  " }, bilingualName],
])("trims the manifest name %j", (name, expected) => {
  expect(parseDesktopExtensionManifest({ ...manifest, name })).toEqual({
    state: "valid",
    manifest: { ...manifest, name: expected },
  });
});

test.each([
  [bilingualName, "en", "Thread Tree"],
  [bilingualName, "zh-CN", "委派树"],
  [bilingualName, "fr", "Thread Tree"],
  [{ en: "Groups delegated Threads" }, "zh-CN", "Groups delegated Threads"],
  ["Thread Tree", "zh-CN", "Thread Tree"],
])("resolves localized extension text %j for %s", (value, locale, expected) => {
  expect(resolveLocalizedExtensionText(value, locale)).toBe(expected);
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
