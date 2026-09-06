import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HostCommandExecutionItem,
  HostFileChange,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  AntigravityAdapter,
  codeActionFileChange,
  completeAntigravityToolItem,
  displayPath,
  parseAntigravityCodeActions,
  startAntigravityToolItem,
  synthesizeAntigravityCommand,
  toolTargetFile,
} from "../src/index.js";

const CWD = path.resolve("/test/adversarial_workspace");
let itemCounter = 0;
const nextItemId = () => hostItemIdSchema.parse(`stress-item-${++itemCounter}`);

const insert = (text: string) => ({ text, type: "UNIFIED_DIFF_LINE_TYPE_INSERT" });
const remove = (text: string) => ({ text, type: "UNIFIED_DIFF_LINE_TYPE_DELETE" });
const keep = (text: string) => ({ text, type: "UNIFIED_DIFF_LINE_TYPE_UNCHANGED" });

/** Builds the File Change agy's Language Server would report for one edit. */
function editChange(
  relativePath: string,
  lines: { text: string; type: string }[],
  createFile = false,
): HostFileChange | null {
  const absolute = path.join(CWD, relativePath).replaceAll("\\", "/").replace(/^\//, "");
  const [action] = parseAntigravityCodeActions({
    steps: [
      {
        type: "CORTEX_STEP_TYPE_CODE_ACTION",
        status: "CORTEX_STEP_STATUS_DONE",
        codeAction: {
          actionResult: {
            edit: {
              absoluteUri: `file:///${absolute}`,
              ...(createFile ? { createFile: true } : {}),
              diff: { unifiedDiff: { lines } },
            },
          },
        },
      },
    ],
  });
  return action ? codeActionFileChange(action, CWD) : null;
}

describe("Antigravity Adversarial & Stress Testing", () => {
  describe("1. Applied edits: line endings, boundaries, and complex payloads", () => {
    it("keeps a CRLF file readable as a line-typed patch", () => {
      const change = editChange(
        "src/crlf.ts",
        [insert("line1\r"), insert("line2\r"), insert("line3\r")],
        true,
      );
      expect(change?.unifiedDiff).toContain("--- /dev/null");
      expect(change?.unifiedDiff).toContain("+++ b/src/crlf.ts");
      expect(change?.unifiedDiff).toContain("@@ -0,0 +1,3 @@");
      expect(change?.unifiedDiff.split("\n")).toHaveLength(8);
    });

    it("reports a pure insertion and a pure deletion with the right ranges", () => {
      const inserted = editChange("empty_target.txt", [insert("newly inserted line")]);
      expect(inserted?.unifiedDiff).toContain("@@ -0,0 +1,1 @@");
      expect(inserted?.unifiedDiff).toContain("+newly inserted line");

      const deleted = editChange("delete_target.txt", [remove("line to delete")]);
      expect(deleted?.unifiedDiff).toContain("@@ -1,1 +0,0 @@");
      expect(deleted?.unifiedDiff).toContain("-line to delete");
    });

    it("drops an edit that changed nothing instead of emitting an empty patch", () => {
      // An empty patch is what Codex Desktop misreads as a phantom +N -0 card.
      expect(editChange("same.ts", [keep("const a = 1;"), keep("const b = 2;")])).toBeNull();
      expect(editChange("empty.ts", [])).toBeNull();
    });

    it("splits edits separated by unchanged lines into multiple hunks", () => {
      const lines = Array.from({ length: 60 }, (_, index) => keep(`line ${index + 1}`));
      lines[2] = insert("MODIFIED LINE 3");
      lines[55] = insert("MODIFIED LINE 56");
      const change = editChange("src/long.ts", lines);
      expect(change?.unifiedDiff).toContain("+MODIFIED LINE 3");
      expect(change?.unifiedDiff).toContain("+MODIFIED LINE 56");
      expect(change?.unifiedDiff.match(/@@ -\d+,\d+ \+\d+,\d+ @@/gu)).toHaveLength(2);
    });

    it("carries multi-byte unicode, emojis, and right-to-left text through unchanged", () => {
      const change = editChange("src/i18n.ts", [
        remove("const greeting = 'Hello'; // 🌲 Initial"),
        insert("const greeting = '🚀 Hello 👨‍👩‍👧‍👦 🎉'; // 🔥 Updated"),
        keep("const cjk = '简体中文 繁體中文 日本語 한국어';"),
        keep("const rtl = 'مرحبا بالعالم';"),
      ]);
      expect(change?.unifiedDiff).toContain("+const greeting = '🚀 Hello 👨‍👩‍👧‍👦 🎉'; // 🔥 Updated");
      expect(change?.unifiedDiff).toContain(" const rtl = 'مرحبا بالعالم';");
    });

    it("processes an extremely long single line quickly", () => {
      const start = Date.now();
      const change = editChange("huge_line.min.js", [
        remove("A".repeat(20_000)),
        insert("A".repeat(10_000) + "B".repeat(10_000)),
      ]);
      expect(Date.now() - start).toBeLessThan(1_000);
      expect(change?.unifiedDiff.length).toBeGreaterThan(40_000);
    });

    it("keeps control characters in content while still rejecting them in a path", () => {
      expect(displayPath("bad\u0000file.txt", CWD)).toBeNull();
      const change = editChange("escaped.txt", [insert("line1\t\u001b[31mRed\u001b[0m")], true);
      expect(change?.unifiedDiff).toContain("+line1\t\u001b[31mRed\u001b[0m");
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

      for (const [index, variant] of variants.entries()) {
        expect(toolTargetFile("write_to_file", variant)).toBe(`file${index + 1}.ts`);
      }
    });

    it("recognizes nested wrappers like input, arguments, params, parameters", () => {
      const nestedCases = [
        { input: { TargetFile: "wrap1.ts", CodeContent: "val1" } },
        { arguments: { targetFile: "wrap2.ts", codeContent: "val2" } },
        { params: { target_file: "wrap3.ts", code_content: "val3" } },
        { parameters: { filePath: "wrap4.ts", content: "val4" } },
      ];

      for (const [index, nested] of nestedCases.entries()) {
        expect(toolTargetFile("write_to_file", nested)).toBe(`wrap${index + 1}.ts`);
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
if (process.argv.includes("models") || process.argv.some((arg) => arg.includes("/usage"))) {
  if (process.argv.includes("models")) {
    process.stdout.write("gemini-3.7-flash-high\\tGemini 3.7 Flash High\\ngemini-3.1-pro-high\\tGemini 3.1 Pro High\\n");
  }
  process.exit(0);
}
const runsDir = ${JSON.stringify(runsDir)};
fs.mkdirSync(runsDir, { recursive: true });
// Only a Turn consumes a scripted response. Quota probes also request
// stream-json output, but unlike Turns they do not use stream-json input.
const isTurn = process.argv.includes("--input-format");
const counter = isTurn ? fs.readdirSync(runsDir).length : -1;
if (isTurn) fs.writeFileSync(path.join(runsDir, "run-" + counter + ".txt"), "");
const allResponses = JSON.parse(fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8'));
const lines = isTurn ? allResponses[counter] || allResponses[0] || [] : [];
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
    it("recognizes file targets and commands behind a tool namespace", () => {
      expect(toolTargetFile("default_api:write_to_file", { TargetFile: "src/namespaced.ts" })).toBe(
        "src/namespaced.ts",
      );
      expect(
        toolTargetFile("functions.replace_file_content", { TargetFile: "src/namespaced.ts" }),
      ).toBe("src/namespaced.ts");

      const cmd = synthesizeAntigravityCommand("default_api:run_command", {
        CommandLine: "node script.js",
      });
      expect(cmd).not.toBeNull();
      expect(cmd?.command).toBe("node script.js");
    });
  });
});
