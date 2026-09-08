import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { DEFAULT_KIRO_FILE_CHANGE_TEXT_LIMIT, projectKiroFileChanges } from "../src/file-diff.js";

describe("kiro file diff projection", () => {
  const workspaceDir = path.resolve("/workspace");

  it("exports default text limit of 4 MiB", () => {
    expect(DEFAULT_KIRO_FILE_CHANGE_TEXT_LIMIT).toBe(4 * 1024 * 1024);
  });

  it("projects update diff with relative path", () => {
    const filePath = path.join(workspaceDir, "src", "index.ts");
    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText: "const a = 1;\n",
          newText: "const a = 2;\n",
        },
      ],
      workspaceDir,
    );

    expect(result).toEqual([
      {
        path: "src/index.ts",
        kind: "update",
        unifiedDiff: expect.stringMatching(
          /--- a\/src\/index\.ts[\s\S]*\+\+\+ b\/src\/index\.ts[\s\S]*-const a = 1;[\s\S]*\+const a = 2;/u,
        ),
      },
    ]);
  });

  it("projects add diff when oldText is null", () => {
    const filePath = path.join(workspaceDir, "docs", "readme.md");
    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText: null,
          newText: "# Title\n",
        },
      ],
      workspaceDir,
    );

    expect(result).toEqual([
      {
        path: "docs/readme.md",
        kind: "add",
        unifiedDiff: expect.stringContaining("--- /dev/null"),
      },
    ]);
  });

  it("resolves file: URLs", () => {
    const filePath = path.join(workspaceDir, "test.ts");
    const fileUri = pathToFileURL(filePath).href;

    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: fileUri,
          oldText: "old\n",
          newText: "new\n",
        },
      ],
      workspaceDir,
    );

    expect(result).toBeDefined();
    expect(result?.[0]?.path).toBe("test.ts");
    expect(result?.[0]?.kind).toBe("update");
  });

  it("filters out identical old and new text", () => {
    const filePath = path.join(workspaceDir, "same.txt");
    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText: "identical content\n",
          newText: "identical content\n",
        },
      ],
      workspaceDir,
    );

    expect(result).toBeNull();
  });

  it("filters out null oldText with empty newText", () => {
    const filePath = path.join(workspaceDir, "empty.txt");
    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText: null,
          newText: "",
        },
      ],
      workspaceDir,
    );

    expect(result).toBeNull();
  });

  it("enforces text byte limit", () => {
    const filePath = path.join(workspaceDir, "large.txt");
    const oldText = "x".repeat(200);
    const newText = "y".repeat(200);

    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText,
          newText,
        },
      ],
      workspaceDir,
      100, // strict 100 byte limit
    );

    expect(result).toBeNull();
  });

  it("rejects duplicate paths in a single tool call", () => {
    const filePath = path.join(workspaceDir, "dup.txt");
    const result = projectKiroFileChanges(
      [
        {
          type: "diff",
          path: filePath,
          oldText: "v1",
          newText: "v2",
        },
        {
          type: "diff",
          path: filePath,
          oldText: "v2",
          newText: "v3",
        },
      ],
      workspaceDir,
    );

    expect(result).toBeNull();
  });

  it("rejects non-array or malformed content", () => {
    expect(projectKiroFileChanges(null, workspaceDir)).toBeNull();
    expect(projectKiroFileChanges("not-an-array", workspaceDir)).toBeNull();
    expect(projectKiroFileChanges([], workspaceDir)).toBeNull();
    expect(
      projectKiroFileChanges([{ type: "not-a-diff", path: "file.txt" }], workspaceDir),
    ).toBeNull();
  });

  it("rejects when diff count exceeds maximum allowed changes", () => {
    const manyDiffs = Array.from({ length: 33 }, (_, i) => ({
      type: "diff",
      path: path.join(workspaceDir, `file_${i}.txt`),
      oldText: "a",
      newText: "b",
    }));

    expect(projectKiroFileChanges(manyDiffs, workspaceDir)).toBeNull();
  });
});
