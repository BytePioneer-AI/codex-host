import path from "node:path";

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
      originalFile: "alpha\nbeta\ndelta\n",
      oldString: "beta",
      newString: "gamma",
      replaceAll: false,
      userModified: false,
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
      snapshot: {
        before: "alpha\nbeta\ndelta\n",
        after: "alpha\ngamma\ndelta\n",
      },
    });
  });

  it("uses Write result type for add and update kinds", () => {
    const created = parseClaudeNativeFileChange("Write", {
      type: "create",
      filePath: "created.txt",
      originalFile: null,
      content: "created\n",
      structuredPatch: [
        { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+created"] },
      ],
    });
    expect(projectClaudeFileChange(requireChange(created), "/workspace")).toMatchObject({
      path: "created.txt",
      kind: "add",
      unifiedDiff: expect.stringContaining("--- /dev/null\n+++ b/created.txt"),
      snapshot: { before: null, after: "created\n" },
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

  it("keeps the native patch but omits an untrustworthy snapshot", () => {
    const change = parseClaudeNativeFileChange("Edit", {
      filePath: "sample.txt",
      originalFile: "old\n",
      oldString: "old",
      newString: "new",
      replaceAll: false,
      userModified: true,
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
      ],
    });

    expect(change).toMatchObject({ path: "sample.txt", kind: "update" });
    expect(change).not.toHaveProperty("snapshot");
  });

  it("preserves an outside-cwd native path without reading the filesystem", () => {
    const native = parseClaudeNativeFileChange("Edit", {
      filePath: "/other/sample.txt",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
      ],
    });
    const expectedPath = path.resolve("/other/sample.txt").replaceAll("\\", "/");
    const absoluteDisplayPath = path.posix.isAbsolute(expectedPath);
    const oldHeader = absoluteDisplayPath ? expectedPath : `a/${expectedPath}`;
    const newHeader = absoluteDisplayPath ? expectedPath : `b/${expectedPath}`;
    expect(projectClaudeFileChange(requireChange(native), "/workspace")).toMatchObject({
      path: expectedPath,
      unifiedDiff: expect.stringContaining(`--- ${oldHeader}\n+++ ${newHeader}`),
    });
  });
});
