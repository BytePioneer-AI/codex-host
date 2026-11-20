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
  expect(desktopExtensionCatalogEntrySchema.parse(entry).trustTier).toBe("community");
  for (const change of [
    { id: "../badge" },
    { name: { en: "Badge" } },
    { description: { en: "Badge", "zh-CN": " " } },
    { version: " " },
    { author: " " },
    { repository: "javascript:alert(1)" },
    { categories: ["unknown"] },
    { slots: ["unknown"] },
    { downloadUrl: "https://example.com/?file=badge.zip" },
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
