import { describe, expect, it } from "vitest";

import { parseClaudeNativeFileChange, projectClaudeFileChange } from "../src/file-change.js";

const hunks = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [" alpha", "-beta", "+gamma"],
  },
  {
    oldStart: 4,
    oldLines: 1,
    newStart: 4,
    newLines: 2,
    lines: [" delta", "+epsilon"],
  },
];

function requireChange<T>(value: T | null): T {
  if (!value) throw new Error("Expected valid Claude native File Change evidence");
  return value;
}

describe("Claude native File Changes", () => {
  it("serializes a validated Edit patch relative to the Session cwd", () => {
    const native = parseClaudeNativeFileChange("Edit", {
      filePath: "/workspace/src/sample.txt",
      originalFile: "ignored",
      structuredPatch: hunks,
    });

    expect(projectClaudeFileChange(requireChange(native), "/workspace")).toEqual({
      path: "src/sample.txt",
      kind: "update",
      unifiedDiff: [
        "--- a/src/sample.txt",
        "+++ b/src/sample.txt",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+gamma",
        "@@ -4,1 +4,2 @@",
        " delta",
        "+epsilon",
        "",
      ].join("\n"),
    });
  });

  it("uses Write result type for add and update kinds", () => {
    const created = parseClaudeNativeFileChange("Write", {
      type: "create",
      filePath: "created.txt",
      structuredPatch: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] },
      ],
    });
    expect(projectClaudeFileChange(requireChange(created), "/workspace")).toMatchObject({
      path: "created.txt",
      kind: "add",
      unifiedDiff: expect.stringContaining("--- /dev/null\n+++ b/created.txt"),
    });

    expect(
      parseClaudeNativeFileChange("Write", {
        type: "update",
        filePath: "updated.txt",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
        ],
      }),
    ).toMatchObject({ kind: "update" });
  });

  it("rejects absent, malformed, ambiguous, and unsupported native evidence", () => {
    const valid = { filePath: "sample.txt", structuredPatch: hunks };
    expect(parseClaudeNativeFileChange("Bash", valid)).toBeNull();
    expect(parseClaudeNativeFileChange("Edit", { filePath: "sample.txt" })).toBeNull();
    expect(parseClaudeNativeFileChange("Edit", { ...valid, structuredPatch: [] })).toBeNull();
    expect(
      parseClaudeNativeFileChange("Edit", {
        ...valid,
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: ["-old"] }],
      }),
    ).toBeNull();
    expect(parseClaudeNativeFileChange("Write", { ...valid, type: "delete" })).toBeNull();
    expect(parseClaudeNativeFileChange("Edit", { ...valid, filePath: "bad\npath" })).toBeNull();
    expect(parseClaudeNativeFileChange("Edit", { ...valid, filePath: "   " })).toBeNull();
  });

  it("preserves an outside-cwd native path without reading the filesystem", () => {
    const native = parseClaudeNativeFileChange("Edit", {
      filePath: "/other/sample.txt",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
      ],
    });
    expect(projectClaudeFileChange(requireChange(native), "/workspace")).toMatchObject({
      path: "/other/sample.txt",
      unifiedDiff: expect.stringContaining("--- /other/sample.txt\n+++ /other/sample.txt"),
    });
  });
});
