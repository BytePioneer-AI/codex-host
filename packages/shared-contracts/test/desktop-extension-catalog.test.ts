import { expect, it } from "vitest";
import {
  compareExtensionVersions,
  desktopExtensionCatalogEntrySchema,
  desktopExtensionCatalogSchema,
} from "../src/desktop-extensions.js";

const entry = {
  id: "example.badge",
  version: "v1.2.3",
  name: { en: "Badge", "zh-CN": "角标" },
  description: { en: "A sidebar badge", "zh-CN": "侧栏角标" },
  author: "Example",
  repository: "https://github.com/example/badge",
  downloadUrl: "https://example.com/badge.ZIP?asset=123",
  sha256: "a".repeat(64),
};

it("defaults to community and rejects invalid catalog metadata or ambiguous IDs", () => {
  const parsed = desktopExtensionCatalogEntrySchema.parse(entry);
  expect(parsed.trustTier).toBe("community");
  expect(parsed).not.toHaveProperty("stars");
  expect(parsed).not.toHaveProperty("downloads");
  expect(parsed).not.toHaveProperty("icon");
  for (const change of [
    { id: "../badge" },
    { name: { en: "Badge" } },
    { description: { en: "Badge", "zh-CN": " " } },
    { version: " " },
    { author: " " },
    { repository: "javascript:alert(1)" },
    { stars: -1 },
    { stars: 1.5 },
    { downloads: -1 },
    { downloads: 1.5 },
    { downloads: "42" },
    { downloads: null },
    { categories: ["unknown"] },
    { slots: ["unknown"] },
    { downloadUrl: "https://example.com/?file=badge.zip" },
    { icon: "file:///tmp/logo.png" },
    { icon: "data:image/png;base64,YQ==" },
    { icon: "https://user:secret@example.com/logo.png" },
    { screenshots: ["file:///tmp/preview.png"] },
    { screenshots: Array(5).fill("https://example.com/preview.png") },
    { sha256: "A".repeat(64) },
  ])
    expect(desktopExtensionCatalogEntrySchema.safeParse({ ...entry, ...change }).success).toBe(
      false,
    );
  expect(
    desktopExtensionCatalogSchema.safeParse({
      schemaVersion: 1,
      generatedAt: "now",
      extensions: [entry, entry],
    }).success,
  ).toBe(false);
});

it.each(["http://example.com/logo.png", "https://example.com/logo.webp"])(
  "preserves a public catalog logo URL %s",
  (icon) => {
    expect(desktopExtensionCatalogEntrySchema.parse({ ...entry, icon }).icon).toBe(icon);
  },
);

it.each([0, 42])("accepts star and download counts of %i", (count) => {
  expect(
    desktopExtensionCatalogEntrySchema.parse({ ...entry, stars: count, downloads: count }),
  ).toMatchObject({
    stars: count,
    downloads: count,
  });
});

it.each([
  ["v1.2.3", "1.2.3+build", 0],
  ["1.10.0", "1.9.9", 1],
  ["v2", "2.0.0", 0],
  ["2.0.0-rc.2", "2.0.0-rc.10", -1],
  ["2.0.0-beta", "2.0.0", -1],
  ["nightly", "2.0.0", 0],
] as const)("compares %s and %s as %i", (a, b, expected) => {
  expect(compareExtensionVersions(a, b)).toBe(expected);
  expect(compareExtensionVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
});
