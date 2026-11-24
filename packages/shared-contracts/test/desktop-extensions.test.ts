import { expect, test } from "vitest";
import {
  desktopExtensionSettingFieldSchema,
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
      categories: ["appearance", "interface", "workflow", "analytics", "integrations", "tools"],
    },
    "valid",
  ],
  [{ categories: ["interface", "interface"] }, "invalid"],
  [{ categories: ["sidebar.thread-layout"] }, "invalid"],
  [{ unexpected: true }, "invalid"],
  [{ backend: "backend.mjs" }, "invalid"],
  [{ backend: { script: "../backend.mjs" } }, "invalid"],
  [{ desktop: undefined, backend: { script: "logic/backend.mjs" } }, "valid"],
  [{ desktop: undefined }, "invalid"],
  [{ slots: [] }, "valid"],
  [{ slots: undefined }, "valid"],
  [{ slots: ["appearance.theme"] }, "valid"],
  [{ name: bilingualName, desktopApi: 2, futureField: true }, "incompatible"],
  [{ slots: ["composer"] }, "invalid"],
  [{ desktop: { script: "../desktop.js" } }, "invalid"],
])("classifies desktop manifest with %j as %s", (patch, state) => {
  expect(parseDesktopExtensionManifest({ ...manifest, ...patch }).state).toBe(state);
});

test.each(["sidebar", "composer", "conversation", "usage-analytics", "memory-knowledge"])(
  "rejects retired Desktop extension category %s",
  (category) => {
    expect(parseDesktopExtensionManifest({ ...manifest, categories: [category] }).state).toBe(
      "invalid",
    );
  },
);

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

test.each(["images/logo.png", "images/Logo.JPG", "logo.jpeg", "logo.webp"])(
  "preserves the relative logo path %s",
  (icon) => {
    expect(parseDesktopExtensionManifest({ ...manifest, icon })).toEqual({
      state: "valid",
      manifest: { ...manifest, icon },
    });
  },
);

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
  { icon: "https://example.com/logo.png" },
  { icon: "/tmp/logo.png" },
  { icon: "C:\\images\\logo.png" },
  { icon: "images/../logo.png" },
  { icon: "images/.. /logo.png" },
  { icon: "images/logo.svg" },
  { icon: ["logo.png"] },
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

test("resolves full skins exclusively without excluding slotless extensions", () => {
  expect(
    resolveDesktopExtensionSlots(
      ["skin", "tool", "second", "settings"],
      [
        { id: "skin", slots: ["appearance.theme"] },
        { id: "second", slots: ["appearance.theme"] },
        { id: "tool" },
        { id: "settings", slots: [] },
      ],
    ),
  ).toEqual({ active: ["skin", "tool", "settings"], conflicts: new Map([["second", "skin"]]) });
});

test("accepts all setting field types and normalizes omitted slots", () => {
  const label = bilingualName;
  const settingsSchema = [
    { key: "visible", type: "boolean", label, default: false },
    { key: "title", type: "string", label, placeholder: label, default: "" },
    { key: "count", type: "number", label, min: 0, default: 0 },
    { key: "blur", type: "range", label, min: 0, max: 10, step: 0.5 },
    { key: "mode", type: "select", label, options: [{ value: "dim", label }], default: "dim" },
  ];
  expect(
    parseDesktopExtensionManifest({ ...manifest, slots: undefined, settingsSchema }),
  ).toMatchObject({
    state: "valid",
    manifest: { slots: [], settingsSchema },
  });
  expect(
    parseDesktopExtensionManifest({
      ...manifest,
      settingsSchema: [settingsSchema[0], settingsSchema[0]],
    }).state,
  ).toBe("invalid");
  expect(
    parseDesktopExtensionManifest({
      ...manifest,
      settingsSchema: Array.from({ length: 33 }, (_, i) => ({
        type: "boolean",
        label,
        key: `f${i}`,
      })),
    }).state,
  ).toBe("invalid");
});

test.each([
  { type: "boolean", key: "not-an-identifier" },
  { type: "string", default: false },
  { type: "range", min: 2 },
  { type: "range", min: 2, max: 1, default: 0 },
  { type: "number", step: 0 },
  { type: "select", options: [{ value: "dim", label: bilingualName }], default: "light" },
])("rejects invalid setting field %j", (patch) => {
  expect(
    desktopExtensionSettingFieldSchema.safeParse({ key: "value", label: bilingualName, ...patch })
      .success,
  ).toBe(false);
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
