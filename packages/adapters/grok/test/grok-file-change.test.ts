import { describe, expect, it } from "vitest";

import { projectGrokFileChanges } from "../src/grok-file-change.js";

describe("Grok ACP file changes", () => {
  it("serializes native before and after text as an update Unified Diff", () => {
    expect(
      projectGrokFileChanges(
        [
          {
            type: "diff",
            path: "/workspace/src/sample.ts",
            oldText: "const value = 1;\n",
            newText: "const value = 2;\n",
          },
        ],
        "/workspace",
      ),
    ).toEqual([
      {
        path: "src/sample.ts",
        kind: "update",
        unifiedDiff: expect.stringMatching(
          /--- a\/src\/sample\.ts[\s\S]*\+\+\+ b\/src\/sample\.ts[\s\S]*-const value = 1;[\s\S]*\+const value = 2;/u,
        ),
      },
    ]);
  });

  it("uses explicit null original text as the only add signal", () => {
    expect(
      projectGrokFileChanges(
        [
          {
            type: "diff",
            path: "/workspace/created.txt",
            oldText: null,
            newText: "created\n",
          },
        ],
        "/workspace",
      ),
    ).toEqual([
      {
        path: "created.txt",
        kind: "add",
        unifiedDiff: expect.stringContaining("--- /dev/null"),
      },
    ]);
    expect(
      projectGrokFileChanges(
        [
          {
            type: "diff",
            path: "/workspace/ambiguous.txt",
            oldText: "",
            newText: "created\n",
          },
        ],
        "/workspace",
      ),
    ).toMatchObject([{ kind: "update" }]);
  });

  it("fails closed for malformed, no-op, duplicate, and oversized Diff Content", () => {
    expect(projectGrokFileChanges({ type: "diff" }, "/workspace")).toBeNull();
    expect(
      projectGrokFileChanges(
        [{ type: "diff", path: "relative.txt", oldText: "old", newText: "new" }],
        "/workspace",
      ),
    ).toBeNull();
    expect(
      projectGrokFileChanges(
        [{ type: "diff", path: "/workspace/file.txt", newText: "new" }],
        "/workspace",
      ),
    ).toBeNull();
    expect(
      projectGrokFileChanges(
        [{ type: "diff", path: "/workspace/file.txt", oldText: "same", newText: "same" }],
        "/workspace",
      ),
    ).toBeNull();
    expect(
      projectGrokFileChanges(
        [
          { type: "diff", path: "/workspace/file.txt", oldText: "one", newText: "two" },
          { type: "diff", path: "/workspace/file.txt", oldText: "two", newText: "three" },
        ],
        "/workspace",
      ),
    ).toBeNull();
    expect(
      projectGrokFileChanges(
        [{ type: "diff", path: "/workspace/file.txt", oldText: "old", newText: "new" }],
        "/workspace",
        5,
      ),
    ).toBeNull();
  });

  it("ignores non-Diff Tool content but rejects a partially invalid Diff set", () => {
    expect(
      projectGrokFileChanges(
        [
          { type: "content", content: { type: "text", text: "edited" } },
          {
            type: "diff",
            path: "/workspace/file.txt",
            oldText: "old\n",
            newText: "new\n",
          },
        ],
        "/workspace",
      ),
    ).toHaveLength(1);
    expect(
      projectGrokFileChanges(
        [
          {
            type: "diff",
            path: "/workspace/file.txt",
            oldText: "old\n",
            newText: "new\n",
          },
          { type: "diff", path: "/workspace/bad.txt", newText: "bad\n" },
        ],
        "/workspace",
      ),
    ).toBeNull();
  });
});
