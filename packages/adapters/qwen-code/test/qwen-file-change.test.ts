import { describe, expect, it } from "vitest";

import { projectQwenCodeFileChanges } from "../src/index.js";

function diff(entry: Record<string, unknown>): unknown[] {
  return [{ type: "diff", ...entry }];
}

describe("Qwen Code file-change projection", () => {
  it("serializes an absolute diff path as an update", () => {
    const changes = projectQwenCodeFileChanges(
      diff({ path: "/tmp/a.txt", oldText: "a\n", newText: "b\n" }),
      "/tmp",
    );
    expect(changes).toEqual([
      {
        path: "a.txt",
        kind: "update",
        unifiedDiff: expect.stringContaining("-a"),
      },
    ]);
  });

  it("resolves the CLI's bare basename against the tool call file_path", () => {
    const changes = projectQwenCodeFileChanges(
      diff({ path: "auth.ts", oldText: "a\n", newText: "b\n" }),
      "/repo",
      { file_path: "/repo/src/auth.ts" },
    );
    expect(changes).toEqual([
      { path: "src/auth.ts", kind: "update", unifiedDiff: expect.stringContaining("src/auth.ts") },
    ]);
  });

  it("fails closed for a relative path without an absolute file_path", () => {
    expect(
      projectQwenCodeFileChanges(diff({ path: "auth.ts", oldText: "a", newText: "b" }), "/repo"),
    ).toBeNull();
    expect(
      projectQwenCodeFileChanges(diff({ path: "auth.ts", oldText: "a", newText: "b" }), "/repo", {
        file_path: "src/auth.ts",
      }),
    ).toBeNull();
  });

  it("treats both null and empty oldText as an add", () => {
    for (const oldText of [null, ""] as const) {
      const changes = projectQwenCodeFileChanges(
        diff({ path: "/repo/new.ts", oldText, newText: "content\n" }),
        "/repo",
      );
      expect(changes).toEqual([
        {
          path: "new.ts",
          kind: "add",
          unifiedDiff: expect.stringContaining("/dev/null"),
        },
      ]);
    }
  });

  it("fails closed for no-op, duplicate, and malformed diff content", () => {
    expect(
      projectQwenCodeFileChanges(
        diff({ path: "/repo/a.ts", oldText: "same", newText: "same" }),
        "/repo",
      ),
    ).toBeNull();
    expect(
      projectQwenCodeFileChanges(diff({ path: "/repo/a.ts", oldText: null, newText: "" }), "/repo"),
    ).toBeNull();
    expect(
      projectQwenCodeFileChanges(
        [
          { type: "diff", path: "/repo/a.ts", oldText: "1", newText: "2" },
          { type: "diff", path: "/repo/a.ts", oldText: "3", newText: "4" },
        ],
        "/repo",
      ),
    ).toBeNull();
    expect(
      projectQwenCodeFileChanges(diff({ path: 42, oldText: "1", newText: "2" }), "/repo"),
    ).toBeNull();
  });
});
