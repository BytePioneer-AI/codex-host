import { describe, expect, it } from "vitest";
import type { HostFileChange } from "@codexhost/harness-adapter";

import { mergeFileChangesByPath } from "../src/index.js";

function change(path: string, before: string | null, after: string | null): HostFileChange {
  return {
    path,
    kind: before === null ? "add" : after === null ? "delete" : "update",
    unifiedDiff: `native diff ${String(before)} -> ${String(after)}`,
    snapshot: { before, after },
  };
}

describe("mergeFileChangesByPath", () => {
  it("computes one baseline-to-final Diff for continuous native states", () => {
    const merged = mergeFileChangesByPath([
      change("PLAN.md", "first\n", "second\n"),
      change("PLAN.md", "second\n", "final\n"),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      path: "PLAN.md",
      kind: "update",
      snapshot: { before: "first\n", after: "final\n" },
    });
    expect(merged[0]?.unifiedDiff).toContain("-first");
    expect(merged[0]?.unifiedDiff).toContain("+final");
    expect(merged[0]?.unifiedDiff).not.toContain("second");
  });

  it("omits changes whose final state equals the baseline", () => {
    expect(
      mergeFileChangesByPath([
        change("reverted.txt", "a\n", "b\n"),
        change("reverted.txt", "b\n", "a\n"),
        change("temporary.txt", null, "temporary\n"),
        change("temporary.txt", "temporary\n", null),
      ]),
    ).toEqual([]);
  });

  it.each([
    [
      "addition",
      [change("file.txt", null, "one\n"), change("file.txt", "one\n", "two\n")],
      "add",
      "--- /dev/null",
    ],
    [
      "deletion",
      [change("file.txt", "one\n", "two\n"), change("file.txt", "two\n", null)],
      "delete",
      "+++ /dev/null",
    ],
  ] as const)("preserves %s semantics", (_label, changes, kind, header) => {
    const merged = mergeFileChangesByPath(changes);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind });
    expect(merged[0]?.unifiedDiff).toContain(header);
  });

  it("keeps native operations when snapshots are incomplete or discontinuous", () => {
    const incomplete: HostFileChange = {
      path: "unknown.txt",
      kind: "update",
      unifiedDiff: "native incomplete",
    };
    const discontinuous = [
      change("split.txt", "a\n", "b\n"),
      change("split.txt", "other\n", "c\n"),
    ];

    expect(mergeFileChangesByPath([incomplete, incomplete])).toEqual([incomplete, incomplete]);
    expect(mergeFileChangesByPath(discontinuous)).toEqual(discontinuous);
  });
});
