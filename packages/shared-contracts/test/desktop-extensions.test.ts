import { expect, test } from "vitest";
import {
  desktopExtensionListItemSchema,
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
    {
      categories: [
        "sidebar",
        "composer",
        "conversation",
        "appearance",
        "tools",
        "workflow",
        "usage-analytics",
        "memory-knowledge",
        "integrations",
      ],
    },
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

test("preserves optional details, author, repository, and screenshot paths", () => {
  const metadata = {
    author: "codexhost",
    repository: "https://github.com/BytePioneer-AI/codex-host",
    details: { en: "First paragraph.\n\nSecond paragraph.", "zh-CN": "第一段。\n\n第二段。" },
    screenshots: ["images/sidebar.png", "images/status.JPG", "details.jpeg", "preview.webp"],
  };
  expect(
    parseDesktopExtensionManifest({ ...manifest, ...metadata, author: " codexhost " }),
  ).toEqual({
    state: "valid",
    manifest: { ...manifest, ...metadata },
  });
  expect(
    parseDesktopExtensionManifest({
      ...manifest,
      repository: "http://example.org/repo",
      details: { en: "a".repeat(16384) },
    }).state,
  ).toBe("valid");
});

test.each([
  { author: " " },
  { author: "a".repeat(129) },
  { details: { "zh-CN": "缺少英文" } },
  { details: { en: "a".repeat(16385) } },
  { details: { en: "Valid English", "zh-CN": "字".repeat(16385) } },
  { repository: "javascript:alert(1)" },
  { repository: "file:///tmp/repo" },
  { repository: "ftp://example.org/repo" },
  { repository: "//example.org/repo" },
  { repository: "https:example.org/repo" },
  { screenshots: ["https://example.com/preview.png"] },
  { screenshots: ["/tmp/preview.png"] },
  { screenshots: ["C:\\images\\preview.png"] },
  { screenshots: ["images/../preview.png"] },
  { screenshots: ["images/.. /preview.png"] },
  { screenshots: ["images/preview.svg"] },
  { screenshots: ["preview.png", "preview.png"] },
  { screenshots: ["1.png", "2.png", "3.png", "4.png", "5.png"] },
])("rejects invalid optional metadata (case %#)", (patch) => {
  expect(parseDesktopExtensionManifest({ ...manifest, ...patch }).state).toBe("invalid");
});

test.each([
  ["data:image/png;base64,YQ==", true],
  ["data:image/svg+xml;base64,YQ==", false],
  ["file:///tmp/screenshot.png", false],
])("only accepts raster data URLs for rendered screenshots: %s", (url, valid) => {
  expect(
    desktopExtensionListItemSchema.safeParse({
      id: manifest.id,
      enabled: false,
      status: { state: "disabled" },
      screenshotDataUrls: [url],
    }).success,
  ).toBe(valid);
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
