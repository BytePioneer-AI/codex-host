import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { structuredPatchToUnifiedPatch, verifyStructuredPatch } from "./patch.mjs";

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../tests/fixtures/gate-claude-code/hermetic.fixture.json",
    ),
    "utf8",
  ),
);

const beforeLf = "alpha\nbeta\ncharlie\ndelta\n";
const afterLf = "alpha\ngamma\ncharlie\ndelta\nepsilon\n";

describe("Claude native structured patches", () => {
  it("serializes multiple native hunks deterministically", () => {
    const patch = structuredPatchToUnifiedPatch("sample.txt", fixture.structuredPatch);
    expect(patch).toContain("--- a/sample.txt\n+++ b/sample.txt");
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain("@@ -4,1 +4,2 @@");
    expect(
      verifyStructuredPatch({
        before: beforeLf,
        after: afterLf,
        displayPath: "sample.txt",
        structuredPatch: fixture.structuredPatch,
      }),
    ).toBe(true);
  });

  it("applies the same native hunks to CRLF without normalizing the file", () => {
    expect(
      verifyStructuredPatch({
        before: beforeLf.replaceAll("\n", "\r\n"),
        after: afterLf.replaceAll("\n", "\r\n"),
        displayPath: "sample.txt",
        structuredPatch: fixture.structuredPatch,
      }),
    ).toBe(true);
  });

  it("rejects malformed hunk counts instead of inferring missing data", () => {
    expect(() =>
      structuredPatchToUnifiedPatch("sample.txt", [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ["-alpha"] },
      ]),
    ).toThrow("oldLines");
  });

  it("rejects an absent native patch", () => {
    expect(() => structuredPatchToUnifiedPatch("sample.txt", [])).toThrow(
      "at least one native hunk",
    );
  });
});
