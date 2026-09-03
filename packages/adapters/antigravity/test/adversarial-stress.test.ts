import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HostCommandExecutionItem, HostToolExecutionItem } from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  AntigravityAdapter,
  completeAntigravityToolItem,
  displayPath,
  startAntigravityToolItem,
  synthesizeAntigravityCommand,
  synthesizeAntigravityFileChange,
} from "../src/index.js";

const CWD = path.resolve("/test/adversarial_workspace");
let itemCounter = 0;
const nextItemId = () => hostItemIdSchema.parse(`stress-item-${++itemCounter}`);

describe("Antigravity Adversarial & Stress Testing", () => {
  describe("1. Line Endings Handling (CRLF, Mixed Endings, Normalization)", () => {
    it("handles write_to_file with CRLF and mixed line endings cleanly", () => {
      const crlfContent = "line1\r\nline2\r\nline3\r\n";
      const mixedContent = "header\r\nbody\nfooter\r\n";

      const changesCrlf = synthesizeAntigravityFileChange(
        "write_to_file",
        { TargetFile: "src/crlf.ts", CodeContent: crlfContent },
        CWD,
      );
      expect(changesCrlf).not.toBeNull();
      const [change1] = changesCrlf ?? [];
      expect(change1?.unifiedDiff).not.toContain("\r");
      expect(change1?.unifiedDiff).toContain("--- /dev/null");
      expect(change1?.unifiedDiff).toContain("+++ b/src/crlf.ts");
      expect(change1?.unifiedDiff).toContain("@@ -0,0 +1,3 @@\n+line1\n+line2\n+line3");

      const changesMixed = synthesizeAntigravityFileChange(
        "write_to_file",
        { TargetFile: "src/mixed.ts", CodeContent: mixedContent, Overwrite: true },
        CWD,
      );
      expect(changesMixed).not.toBeNull();
      const [change2] = changesMixed ?? [];
      expect(change2?.unifiedDiff).not.toContain("\r");
      expect(change2?.unifiedDiff).toContain("--- a/src/mixed.ts");
      expect(change2?.unifiedDiff).toContain("+++ b/src/mixed.ts");
      expect(change2?.unifiedDiff).toContain("@@ -0,0 +1,3 @@\n+header\n+body\n+footer");
    });

    it("handles replace_file_content with mismatched CRLF and LF line endings between target and replacement", () => {
      const targetContent = "function test() {\r\n  return 1;\r\n}\r\n";
      const replacementContent = "function test() {\n  return 2;\n}\n";

      const changes = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "src/service.ts",
          TargetContent: targetContent,
          ReplacementContent: replacementContent,
        },
        CWD,
      );
      expect(changes).not.toBeNull();
      const [change] = changes ?? [];
      expect(change?.kind).toBe("update");
      expect(change?.unifiedDiff).not.toContain("\r");
      expect(change?.unifiedDiff).toContain("-  return 1;");
      expect(change?.unifiedDiff).toContain("+  return 2;");
    });
  });

  describe("2. Boundary Diffs (Empty, Identical, Zero-line)", () => {
    it("handles empty target or empty replacement in replace_file_content", () => {
      // Insertion into empty
      const insertChanges = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "empty_target.txt",
          TargetContent: "",
          ReplacementContent: "newly inserted line\n",
        },
        CWD,
      );
      expect(insertChanges).not.toBeNull();
      const [insert] = insertChanges ?? [];
      expect(insert?.unifiedDiff).toContain("+newly inserted line");

      // Deletion to empty
      const deleteChanges = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "delete_target.txt",
          TargetContent: "line to delete\n",
          ReplacementContent: "",
        },
        CWD,
      );
      expect(deleteChanges).not.toBeNull();
      const [del] = deleteChanges ?? [];
      expect(del?.unifiedDiff).toContain("-line to delete");

      // Both empty
      const emptyBoth = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "both_empty.txt",
          TargetContent: "",
          ReplacementContent: "",
        },
        CWD,
      );
      expect(emptyBoth).not.toBeNull();
      const [emptyChange] = emptyBoth ?? [];
      expect(emptyChange?.kind).toBe("update");
      expect(emptyChange?.unifiedDiff).toBeDefined();
    });

    it("handles identical TargetContent and ReplacementContent without throwing or corrupting", () => {
      const sameText = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
      const changes = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "same.ts",
          TargetContent: sameText,
          ReplacementContent: sameText,
        },
        CWD,
      );
      expect(changes).not.toBeNull();
      const [change] = changes ?? [];
      expect(change?.kind).toBe("update");
      expect(change?.path).toBe("same.ts");
      expect(typeof change?.unifiedDiff).toBe("string");
    });
  });

  describe("3. Complex Payloads (Multi-hunk, Unicode, Emojis, Long Lines, Binary)", () => {
    it("generates correct multi-hunk unified diffs when edits are separated by unchanged lines", () => {
      const oldLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
      const newLinesArray = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
      newLinesArray[2] = "MODIFIED LINE 3";
      newLinesArray[55] = "MODIFIED LINE 56";
      const newLines = newLinesArray.join("\n");

      const changes = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "src/long.ts",
          TargetContent: oldLines,
          ReplacementContent: newLines,
        },
        CWD,
      );
      expect(changes).not.toBeNull();
      const [change] = changes ?? [];
      expect(change?.unifiedDiff).toContain("-line 3");
      expect(change?.unifiedDiff).toContain("+MODIFIED LINE 3");
      expect(change?.unifiedDiff).toContain("-line 56");
      expect(change?.unifiedDiff).toContain("+MODIFIED LINE 56");
      // Multi-hunk diff contains multiple @@ markers
      const hunkMatches = change?.unifiedDiff.match(/@@ -\d+,\d+ \+\d+,\d+ @@/g);
      expect(hunkMatches?.length).toBeGreaterThanOrEqual(2);
    });

    it("safely handles multi-byte unicode, emojis, and right-to-left characters", () => {
      const unicodeOld =
        "const greeting = 'Hello'; // 🌲 Initial\nconst cjk = '简体中文 繁體中文 日本語 한국어';\nconst rtl = 'مرحبا بالعالم';\n";
      const unicodeNew =
        "const greeting = '🚀 Hello 👨‍👩‍👧‍👦 🎉'; // 🔥 Updated\nconst cjk = '简体中文 繁體中文 日本語 한국어 - 2026';\nconst rtl = 'مرحبا بالعالم - شغال';\n";

      const changes = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "src/i18n.ts",
          TargetContent: unicodeOld,
          ReplacementContent: unicodeNew,
        },
        CWD,
      );
      expect(changes).not.toBeNull();
      const [change] = changes ?? [];
      expect(change?.unifiedDiff).toContain("+const greeting = '🚀 Hello 👨‍👩‍👧‍👦 🎉'; // 🔥 Updated");
      expect(change?.unifiedDiff).toContain(
        "+const cjk = '简体中文 繁體中文 日本語 한국어 - 2026';",
      );
      expect(change?.unifiedDiff).toContain("+const rtl = 'مرحبا بالعالم - شغال';");
    });

    it("safely processes extremely long single lines (>20,000 characters) without hanging or crashing", () => {
      const hugeLineOld = "A".repeat(20_000) + "\n";
      const hugeLineNew = "A".repeat(10_000) + "B".repeat(10_000) + "\n";

      const start = Date.now();
      const changes = synthesizeAntigravityFileChange(
        "replace_file_content",
        {
          TargetFile: "huge_line.min.js",
          TargetContent: hugeLineOld,
          ReplacementContent: hugeLineNew,
        },
        CWD,
      );
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000); // Must be fast
      expect(changes).not.toBeNull();
      const [change] = changes ?? [];
      expect(change?.path).toBe("huge_line.min.js");
      expect(change?.unifiedDiff.length).toBeGreaterThan(20_000);
    });

    it("safely handles control characters and escape sequences in file content", () => {
      const escapeContent = "line1\t\x1b[31mRed Text\x1b[0m\0\b\f\v";
      // displayPath should reject null byte in file path
      expect(displayPath("bad\0file.txt", CWD)).toBeNull();

      // But CodeContent with control chars should not crash diff synthesizer
      const changes = synthesizeAntigravityFileChange(
        "write_to_file",
        {
          TargetFile: "escaped.txt",
          CodeContent: escapeContent,
        },
        CWD,
      );
      expect(changes).not.toBeNull();
    });
  });

  describe("4. Parameter Missing & Fallback Resilience", () => {
    it("falls back to HostToolExecutionItem on any missing required parameters", () => {
      const item1 = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: { parameters: { CodeContent: "some code" } }, // missing TargetFile
        },
        CWD,
      );
      expect(item1.type).toBe("toolExecution");
      expect((item1 as HostToolExecutionItem).toolName).toBe("write_to_file");

      const item2 = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "replace_file_content",
          tool_info: { parameters: { TargetFile: "a.ts", TargetContent: "foo" } }, // missing ReplacementContent
        },
        CWD,
      );
      expect(item2.type).toBe("toolExecution");

      const item3 = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { Cwd: "/workspace" } }, // missing CommandLine
        },
        CWD,
      );
      expect(item3.type).toBe("toolExecution");

      const item4 = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "   " } }, // whitespace only
        },
        CWD,
      );
      expect(item4.type).toBe("toolExecution");
    });

    it("safely handles non-object parameters, nulls, arrays, numbers, and malformed json strings", () => {
      for (const badParam of [null, undefined, 123, true, ["array"], "{invalid-json"]) {
        const item = startAntigravityToolItem(
          nextItemId(),
          {
            conversation_id: "c1",
            step_index: 5,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "write_to_file",
            tool_info: { parameters: badParam as unknown as Record<string, unknown> },
          },
          CWD,
        );
        expect(item.type).toBe("toolExecution");
      }
    });
  });

  describe("5. Parameter Casing & Nested Wrappers", () => {
    it("recognizes PascalCase, camelCase, snake_case, and alias parameter keys for write_to_file", () => {
      const variants = [
        { TargetFile: "file1.ts", CodeContent: "content1" },
        { targetFile: "file2.ts", codeContent: "content2" },
        { target_file: "file3.ts", code_content: "content3" },
        { filePath: "file4.ts", content: "content4" },
        { file_path: "file5.ts", new_string: "content5" },
        { file: "file6.ts", newString: "content6" },
        { path: "file7.ts", text: "content7" },
      ];

      for (const variant of variants) {
        const changes = synthesizeAntigravityFileChange("write_to_file", variant, CWD);
        expect(changes).not.toBeNull();
        expect(changes?.[0]?.kind).toBe("add");
      }
    });

    it("recognizes nested wrappers like input, arguments, params, parameters", () => {
      const nestedCases = [
        { input: { TargetFile: "wrap1.ts", CodeContent: "val1" } },
        { arguments: { targetFile: "wrap2.ts", codeContent: "val2" } },
        { params: { target_file: "wrap3.ts", code_content: "val3" } },
        { parameters: { filePath: "wrap4.ts", content: "val4" } },
      ];

      for (const nested of nestedCases) {
        const changes = synthesizeAntigravityFileChange("write_to_file", nested, CWD);
        expect(changes).not.toBeNull();
        expect(changes?.[0]?.kind).toBe("add");
      }
    });

    it("recognizes command aliases and casings for run_command", () => {
      const cmdVariants = [
        { CommandLine: "cargo test", Cwd: "/rust" },
        { commandLine: "cargo test", cwd: "/rust" },
        { command_line: "cargo test", workingDirectory: "/rust" },
        { command: "cargo test", working_directory: "/rust" },
        { cmd: "cargo test" },
        { script: "cargo test" },
      ];

      for (const variant of cmdVariants) {
        const cmd = synthesizeAntigravityCommand("run_command", variant);
        expect(cmd).not.toBeNull();
        expect(cmd?.command).toBe("cargo test");
      }
    });
  });

  describe("6. run_command Durations, Errors, and 1MB+ Large Output Truncation", () => {
    it("properly formats durationMs and exitCode for successful and failing commands", () => {
      const started = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 10,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "python test.py" } },
        },
        CWD,
      );

      // Normal duration
      const comp1 = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 10,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 3.456,
          tool_info: { output: "Finished in 3.4s" },
        },
        64_000,
      ) as HostCommandExecutionItem;
      expect(comp1.durationMs).toBe(3456);
      expect(comp1.exitCode).toBe(0);

      // Negative or zero duration
      const comp2 = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 10,
          state: "ERROR",
          step_type: "tool",
          duration_seconds: -1.5,
          tool_info: { error: "Traceback error" },
        },
        64_000,
      ) as HostCommandExecutionItem;
      expect(comp2.durationMs).toBe(0);
      expect(comp2.exitCode).toBe(1);
      expect(comp2.output).toBe("Traceback error");
    });

    it("safely truncates huge stdout/stderr (>1MB) without memory leak or crash", () => {
      const hugeOutput = "A".repeat(1_500_000); // 1.5MB string
      const started = startAntigravityToolItem(
        nextItemId(),
        {
          conversation_id: "c1",
          step_index: 11,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "dump_logs" } },
        },
        CWD,
      );

      const limit = 64_000;
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 11,
          state: "DONE",
          step_type: "tool",
          tool_info: { output: hugeOutput },
        },
        limit,
      ) as HostCommandExecutionItem;

      expect(completed.output).toHaveLength(limit);
      expect(completed.outputTruncated).toBe(true);
    });
  });

  describe("7. Session Lifecycle: Rapid Turns, Aborts, Model Changes, Busy State", () => {
    async function fakeSessionHarness(responses: Array<string[]>): Promise<{
      command: string;
      cwd: string;
      cleanup(): Promise<void>;
    }> {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-stress-"));
      const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-stress-cwd-"));
      const cleanup = async (): Promise<void> => {
        for (const target of [directory, cwd]) {
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      };

      const runsFile = path.join(directory, "responses.json");
      await writeFile(runsFile, JSON.stringify(responses));
      const runsDir = path.join(directory, "runs");

      const jsPath = path.join(directory, "agy.cjs");
      const scriptContent = `
const fs = require('fs');
const path = require('path');
if (process.argv.includes("models")) {
  process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\ngemini-3.1-pro-high\\tGemini 3.1 Pro High\\n");
  process.exit(0);
}
const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
const counter = fs.readdirSync(runsDir).length;
fs.writeFileSync(path.join(runsDir, "run-" + counter + ".txt"), "");
const allResponses = JSON.parse(fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8'));
const lines = allResponses[counter] || allResponses[0] || [];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`;
      await writeFile(jsPath, scriptContent);
      if (process.platform === "win32") {
        const command = path.join(directory, "agy.cmd");
        await writeFile(command, `@node "${jsPath}" %*\r\n`);
        return { command, cwd, cleanup };
      }
      const command = path.join(directory, "agy");
      await writeFile(command, `#!/usr/bin/env node\n${scriptContent}`);
      await chmod(command, 0o755);
      return { command, cwd, cleanup };
    }

    it("handles rapid consecutive turns and maintains snapshot consistency", async () => {
      const turn1Lines = [
        JSON.stringify({ event: "init", conversation_id: "conv-rapid" }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-rapid",
            status: "SUCCESS",
            num_turns: 1,
            response: "Turn 1 done",
          },
        }),
      ];
      const turn2Lines = [
        JSON.stringify({ event: "init", conversation_id: "conv-rapid" }),
        JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv-rapid",
            status: "SUCCESS",
            num_turns: 2,
            response: "Turn 2 done",
          },
        }),
      ];

      const { command, cwd, cleanup } = await fakeSessionHarness([turn1Lines, turn2Lines]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const iterator = session.outputs[Symbol.asyncIterator]();

        // Turn 1
        const t1 = hostTurnIdSchema.parse("t1");
        const res1 = await session.execute({
          type: "turn.start",
          turnId: t1,
          input: [{ type: "text", text: "first turn" }],
        });
        expect(res1.ok).toBe(true);

        // While turn 1 is active, second turn should be refused with sessionBusy
        const busyRes = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t-busy"),
          input: [{ type: "text", text: "concurrent turn" }],
        });
        expect(busyRes.ok).toBe(false);
        if (!busyRes.ok) {
          expect(busyRes.error.code).toBe("sessionBusy");
        }

        // Drain turn 1 events
        let ev;
        while ((ev = (await iterator.next()).value)) {
          if (ev.kind === "event" && ev.event.type === "turn.completed") break;
        }

        // Turn 2
        const t2 = hostTurnIdSchema.parse("t2");
        const res2 = await session.execute({
          type: "turn.start",
          turnId: t2,
          input: [{ type: "text", text: "second turn" }],
        });
        expect(res2.ok).toBe(true);

        // Drain turn 2 events
        while ((ev = (await iterator.next()).value)) {
          if (ev.kind === "event" && ev.event.type === "turn.completed") break;
        }

        // Check snapshot contains both turns
        const snapshot = await session.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns).toHaveLength(2);
        }

        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects empty or whitespace-only turn input without starting a child process", async () => {
      const { command, cwd, cleanup } = await fakeSessionHarness([[]]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const res = await session.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("t-empty"),
          input: [{ type: "text", text: "   \n\t  " }],
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("invalidRequest");
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });

    it("rejects cancel on non-active turn with invalidState", async () => {
      const { command, cwd, cleanup } = await fakeSessionHarness([[]]);
      const adapter = new AntigravityAdapter({ command });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        expect(opened.ok).toBe(true);
        if (!opened.ok) return;

        const session = opened.value;
        const cancelRes = await session.execute({
          type: "turn.cancel",
          turnId: hostTurnIdSchema.parse("t-nonexistent"),
        });
        expect(cancelRes.ok).toBe(false);
        if (!cancelRes.ok) {
          expect(cancelRes.error.code).toBe("invalidState");
        }
        await session.close();
      } finally {
        await adapter.close();
        await cleanup();
      }
    });
  });

  describe("8. Namespaced Tool Identifiers (default_api:*, functions.*)", () => {
    it("synthesizes file change and command for namespaced tool identifiers", () => {
      const fileChange = synthesizeAntigravityFileChange(
        "default_api:write_to_file",
        { TargetFile: "src/namespaced.ts", CodeContent: "const x = 42;" },
        CWD,
      );
      expect(fileChange).not.toBeNull();
      expect(fileChange?.[0]?.kind).toBe("add");
      expect(fileChange?.[0]?.path).toBe("src/namespaced.ts");

      const replaceChange = synthesizeAntigravityFileChange(
        "default_api:replace_file_content",
        {
          TargetFile: "src/namespaced.ts",
          TargetContent: "const x = 42;",
          ReplacementContent: "const x = 100;",
        },
        CWD,
      );
      expect(replaceChange).not.toBeNull();
      expect(replaceChange?.[0]?.kind).toBe("update");

      const cmd = synthesizeAntigravityCommand("default_api:run_command", {
        CommandLine: "node script.js",
      });
      expect(cmd).not.toBeNull();
      expect(cmd?.command).toBe("node script.js");
    });
  });
});
