import { describe, expect, it } from "vitest";
import type { HostExtensionCatalogEntry } from "@codexhost/shared-contracts";
import { selectFeaturedCatalogEntries } from "../src/client/web-extensions-helpers.ts";

function makeEntry(
  id: string,
  overrides: Partial<HostExtensionCatalogEntry> = {},
): HostExtensionCatalogEntry {
  return {
    id,
    format: "codexhost",
    name: { en: id, "zh-CN": id },
    description: { en: `${id} description`, "zh-CN": `${id} 描述` },
    version: "1.0.0",
    targets: ["desktop", "web"],
    apis: { page: 1 },
    downloadUrl: `https://github.com/owner/${id}/releases/download/v1.0.0/${id}.zip`,
    ...overrides,
  };
}

describe("selectFeaturedCatalogEntries", () => {
  it("prioritizes explicit featured entries sorted by featuredOrder and rank without truncating at default limit 3", () => {
    const entries: HostExtensionCatalogEntry[] = [
      makeEntry("official-high-downloads", { trustTier: "official", downloads: 5000 }),
      makeEntry("curated-third", { featured: true, featuredOrder: 3 }),
      makeEntry("curated-first", { featured: true, featuredOrder: 1 }),
      makeEntry("curated-unordered-low", { featured: true, downloads: 10 }),
      makeEntry("curated-unordered-high", { featured: true, downloads: 200 }),
      makeEntry("curated-second", { featured: true, featuredOrder: 2 }),
      makeEntry("explicit-false", { featured: false, featuredOrder: 0, downloads: 9999 }),
    ];

    const selected = selectFeaturedCatalogEntries(entries, 3);
    expect(selected.map((entry) => entry.id)).toEqual([
      "curated-first",
      "curated-second",
      "curated-third",
      "curated-unordered-high",
      "curated-unordered-low",
    ]);
  });

  it("falls back to automatic top-N ranking when no entry sets featured: true", () => {
    const entries: HostExtensionCatalogEntry[] = [
      makeEntry("alpha", { downloads: 100 }),
      makeEntry("beta", { trustTier: "official", downloads: 50 }),
      makeEntry("gamma", { downloads: 500 }),
      makeEntry("delta", { downloads: 300 }),
    ];

    const selected = selectFeaturedCatalogEntries(entries, 3);
    expect(selected.map((entry) => entry.id)).toEqual(["beta", "gamma", "delta"]);
  });
});
