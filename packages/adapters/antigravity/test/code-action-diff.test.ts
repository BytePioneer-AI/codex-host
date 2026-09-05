import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  codeActionFileChange,
  parseAntigravityCodeActions,
  type AntigravityCodeAction,
} from "../src/index.js";

const CWD = path.resolve("/test/workspace");

const insert = (text?: string) => ({
  ...(text === undefined ? {} : { text }),
  type: "UNIFIED_DIFF_LINE_TYPE_INSERT",
});
const remove = (text: string) => ({ text, type: "UNIFIED_DIFF_LINE_TYPE_DELETE" });
const keep = (text?: string) => ({
  ...(text === undefined ? {} : { text }),
  type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED",
});

/** Mirrors a real `GetCascadeTrajectorySteps` response. */
function trajectory(
  edits: { uri: string; createFile?: boolean; lines: unknown[] }[],
): Record<string, unknown> {
  return {
    steps: [
      { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE", userInput: {} },
      ...edits.map(({ uri, createFile, lines }) => ({
        type: "CORTEX_STEP_TYPE_CODE_ACTION",
        status: "CORTEX_STEP_STATUS_DONE",
        codeAction: {
          actionSpec: { command: { isEdit: true } },
          actionResult: {
            edit: {
              absoluteUri: uri,
              ...(createFile ? { createFile: true } : {}),
              diff: { unifiedDiff: { lines } },
            },
          },
        },
      })),
    ],
  };
}

function requireAction(action: AntigravityCodeAction | undefined): AntigravityCodeAction {
  if (!action) throw new Error("Expected a parsed Code Action");
  return action;
}

const fileUri = (relative: string) =>
  `file:///${path.join(CWD, relative).replaceAll("\\", "/").replace(/^\//, "")}`;

describe("Antigravity Code Action diffs", () => {
  describe("parseAntigravityCodeActions", () => {
    it("reads applied edits and ignores non-edit steps", () => {
      const actions = parseAntigravityCodeActions(
        trajectory([{ uri: fileUri("src/app.ts"), lines: [insert("a"), keep("b")] }]),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]?.createFile).toBe(false);
      expect(actions[0]?.lines).toEqual([
        { text: "a", type: "insert" },
        { text: "b", type: "unchanged" },
      ]);
      expect(path.resolve(actions[0]?.absolutePath ?? "")).toBe(path.join(CWD, "src", "app.ts"));
    });

    it("treats a line with no text as an empty line", () => {
      const actions = parseAntigravityCodeActions(
        trajectory([{ uri: fileUri("a.ts"), lines: [insert(), keep()] }]),
      );
      expect(actions[0]?.lines).toEqual([
        { text: "", type: "insert" },
        { text: "", type: "unchanged" },
      ]);
    });

    it("skips steps with an unusable payload", () => {
      expect(parseAntigravityCodeActions(null)).toEqual([]);
      expect(
        parseAntigravityCodeActions({ steps: [{ type: "CORTEX_STEP_TYPE_CODE_ACTION" }] }),
      ).toEqual([]);
      expect(
        parseAntigravityCodeActions(
          trajectory([
            { uri: fileUri("a.ts"), lines: [{ type: "UNIFIED_DIFF_LINE_TYPE_UNSPECIFIED" }] },
          ]),
        ),
      ).toEqual([]);
    });
  });

  describe("codeActionFileChange", () => {
    it("emits a created file as a single add hunk covering every line", () => {
      const [action] = parseAntigravityCodeActions(
        trajectory([
          {
            uri: fileUri("stack.py"),
            createFile: true,
            lines: [insert("one"), insert(), insert("three")],
          },
        ]),
      );
      const change = codeActionFileChange(requireAction(action), CWD);
      expect(change).toEqual({
        path: "stack.py",
        kind: "add",
        unifiedDiff: [
          "diff --git a/stack.py b/stack.py",
          "--- /dev/null",
          "+++ b/stack.py",
          "@@ -0,0 +1,3 @@",
          "+one",
          "+",
          "+three",
          "",
        ].join("\n"),
      });
    });

    it("hunks a whole-file edit down to the changed lines plus context", () => {
      // The Language Server reports every line of the file, so an edit near the
      // top must not drag the untouched tail into the card.
      const body = Array.from({ length: 20 }, (_, index) => keep(`line${index + 1}`));
      const [action] = parseAntigravityCodeActions(
        trajectory([{ uri: fileUri("src/mod.ts"), lines: [insert("# header"), ...body] }]),
      );
      const change = codeActionFileChange(requireAction(action), CWD);
      expect(change?.kind).toBe("update");
      expect(change?.unifiedDiff).toContain("--- a/src/mod.ts");
      expect(change?.unifiedDiff).toContain("@@ -1,3 +1,4 @@");
      expect(change?.unifiedDiff).toContain("+# header");
      expect(change?.unifiedDiff).toContain(" line3");
      expect(change?.unifiedDiff).not.toContain("line5");
    });

    it("numbers hunks from the old and new sides independently", () => {
      const [action] = parseAntigravityCodeActions(
        trajectory([
          {
            uri: fileUri("a.ts"),
            lines: [
              keep("a"),
              keep("b"),
              keep("c"),
              remove("old"),
              insert("new"),
              keep("d"),
              keep("e"),
              keep("f"),
            ],
          },
        ]),
      );
      const change = codeActionFileChange(requireAction(action), CWD);
      expect(change?.unifiedDiff).toContain("@@ -1,7 +1,7 @@");
      expect(change?.unifiedDiff).toContain("-old");
      expect(change?.unifiedDiff).toContain("+new");
    });

    it("splits distant edits into separate hunks", () => {
      const lines = [
        insert("top"),
        ...Array.from({ length: 20 }, (_, index) => keep(`line${index + 1}`)),
        insert("bottom"),
      ];
      const [action] = parseAntigravityCodeActions(trajectory([{ uri: fileUri("a.ts"), lines }]));
      const change = codeActionFileChange(requireAction(action), CWD);
      const hunks = (change?.unifiedDiff.match(/^@@ /gmu) ?? []).length;
      expect(hunks).toBe(2);
    });

    it("returns null when nothing actually changed", () => {
      const [action] = parseAntigravityCodeActions(
        trajectory([{ uri: fileUri("a.ts"), lines: [keep("a"), keep("b")] }]),
      );
      expect(codeActionFileChange(requireAction(action), CWD)).toBeNull();
    });

    it("keeps an edit outside the workspace addressable by absolute path", () => {
      const outside = path.resolve("/elsewhere/other.ts");
      const uri = `file:///${outside.replaceAll("\\", "/").replace(/^\//, "")}`;
      const [action] = parseAntigravityCodeActions(
        trajectory([{ uri, createFile: true, lines: [insert("x")] }]),
      );
      const change = codeActionFileChange(requireAction(action), CWD);
      expect(change?.path).toBe(outside.replaceAll("\\", "/"));
      expect(change?.unifiedDiff).toContain(`+++ ${outside.replaceAll("\\", "/")}`);
    });
  });
});
