import path from "node:path";

import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  completeAntigravityToolItem,
  displayPath,
  isAntigravityFileMutatingTool,
  startAntigravityToolItem,
  synthesizeAntigravityCommand,
  toolTargetFile,
} from "../src/index.js";

const CWD = path.resolve("/test/workspace");
const newItemId = () => hostItemIdSchema.parse("item-12345");

describe("Antigravity Tool Projection", () => {
  describe("displayPath", () => {
    it("handles relative path inside cwd", () => {
      const result = displayPath("src/index.ts", CWD);
      expect(result).toEqual({ path: "src/index.ts", absolute: false });
    });

    it("handles absolute path inside cwd", () => {
      const absPath = path.join(CWD, "src", "file.ts");
      const result = displayPath(absPath, CWD);
      expect(result).toEqual({ path: "src/file.ts", absolute: false });
    });

    it("handles path outside cwd", () => {
      const outsidePath = path.resolve("/other/repo/file.ts");
      const result = displayPath(outsidePath, CWD);
      expect(result).not.toBeNull();
      expect(result?.absolute).toBe(true);
      expect(result?.path).toContain("file.ts");
    });

    it("returns null for invalid or empty paths", () => {
      expect(displayPath("", CWD)).toBeNull();
      expect(displayPath("   ", CWD)).toBeNull();
      expect(displayPath("file\0null.ts", CWD)).toBeNull();
      expect(displayPath("file\nname.ts", CWD)).toBeNull();
    });
  });

  describe("toolTargetFile", () => {
    it("reads the target of every file-mutating agy tool", () => {
      // agy's stream carries only the path for these tools, never the content.
      for (const tool of [
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "sed_file",
        "notebook_edit",
      ]) {
        expect(isAntigravityFileMutatingTool(tool)).toBe(true);
        expect(toolTargetFile(tool, { TargetFile: "src/app.ts" })).toBe("src/app.ts");
      }
    });

    it("unwraps a JSON-encoded parameter object and quoted values", () => {
      expect(toolTargetFile("write_to_file", '{"TargetFile":"src/app.ts"}')).toBe("src/app.ts");
      expect(toolTargetFile("write_to_file", { TargetFile: '"src/app.ts"' })).toBe("src/app.ts");
    });

    it("returns null for non-mutating tools and missing targets", () => {
      expect(toolTargetFile("run_command", { CommandLine: "npm test" })).toBeNull();
      expect(toolTargetFile("view_file", { AbsolutePath: "/a/b" })).toBeNull();
      expect(toolTargetFile("write_to_file", { CodeContent: "x" })).toBeNull();
      expect(toolTargetFile("write_to_file", { TargetFile: "   " })).toBeNull();
    });
  });

  describe("synthesizeAntigravityCommand", () => {
    it("recognizes run_command with CommandLine and Cwd", () => {
      const result = synthesizeAntigravityCommand("run_command", {
        CommandLine: "git status",
        Cwd: "/workspace/project",
      });
      expect(result).toEqual({
        command: "git status",
        cwd: "/workspace/project",
      });
    });

    it("supports camelCase and alternate tool names", () => {
      expect(synthesizeAntigravityCommand("runCommand", { commandLine: "pytest" })).toEqual({
        command: "pytest",
      });
      expect(synthesizeAntigravityCommand("bash", { command: "cargo build" })).toEqual({
        command: "cargo build",
      });
      expect(synthesizeAntigravityCommand("terminal", { cmd: "echo 1" })).toEqual({
        command: "echo 1",
      });
    });

    it("returns null when command line is empty or missing", () => {
      expect(synthesizeAntigravityCommand("run_command", { CommandLine: "" })).toBeNull();
      expect(synthesizeAntigravityCommand("run_command", { CommandLine: "   " })).toBeNull();
      expect(synthesizeAntigravityCommand("run_command", {})).toBeNull();
    });

    it("returns null for other tools", () => {
      expect(
        synthesizeAntigravityCommand("write_to_file", { TargetFile: "a.txt", CodeContent: "x" }),
      ).toBeNull();
    });
  });

  describe("startAntigravityToolItem", () => {
    it("creates HostCommandExecutionItem for run_command", () => {
      const item = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: {
            parameters: {
              CommandLine: "npm test",
              Cwd: "/app",
            },
          },
        },
        CWD,
      );
      expect(item.type).toBe("commandExecution");
      if (item.type === "commandExecution") {
        expect(item.command).toBe("npm test");
        expect(item.cwd).toBe("/app");
      }
    });

    it("falls back to HostToolExecutionItem for generic tools", () => {
      const item = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "grep_search",
          tool_info: {
            parameters: { Query: "foo", SearchPath: "/app" },
          },
        },
        CWD,
      );
      expect(item.type).toBe("toolExecution");
      if (item.type === "toolExecution") {
        expect(item.toolName).toBe("grep_search");
        expect(item.arguments).toEqual({ Query: "foo", SearchPath: "/app" });
      }
    });

    it("falls back to HostToolExecutionItem if specialized tool parameters are malformed", () => {
      const item = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 5,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            parameters: { TargetFile: "foo.txt" }, // missing CodeContent
          },
        },
        CWD,
      );
      expect(item.type).toBe("toolExecution");
    });
  });

  describe("completeAntigravityToolItem", () => {
    it("leaves an Adapter-resolved File Change Item untouched on completion", () => {
      const item = {
        type: "fileChange" as const,
        itemId: newItemId(),
        changes: [
          {
            path: "a.ts",
            kind: "add" as const,
            unifiedDiff:
              "diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+const x = 1;\n",
          },
        ],
      };
      const completed = completeAntigravityToolItem(
        item,
        {
          conversation_id: "c1",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 0.15,
          tool_info: { parameters: { TargetFile: "a.ts" }, output: "File written successfully." },
        },
        64_000,
        CWD,
      );
      expect(completed).toEqual(item);
    });

    it("completes commandExecution item with output, exitCode, and durationMs", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "echo test" } },
        },
        CWD,
      );
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 1.234,
          tool_info: { output: "test\n" },
        },
        64_000,
      );
      expect(completed.type).toBe("commandExecution");
      if (completed.type === "commandExecution") {
        expect(completed.output).toBe("test\n");
        expect(completed.exitCode).toBe(0);
        expect(completed.durationMs).toBe(1234);
      }
    });

    it("completes commandExecution with exitCode 1 on error", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 3,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "exit 1" } },
        },
        CWD,
      );
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 3,
          state: "ERROR",
          step_type: "tool",
          tool_info: { error: "Command failed with exit code 1" },
        },
        64_000,
      );
      expect(completed.type).toBe("commandExecution");
      if (completed.type === "commandExecution") {
        expect(completed.exitCode).toBe(1);
        expect(completed.output).toBe("Command failed with exit code 1");
      }
    });

    it("truncates tool output exceeding output limit", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 4,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "cat large.log" } },
        },
        CWD,
      );
      const longOutput = "x".repeat(100);
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 4,
          state: "DONE",
          step_type: "tool",
          tool_info: { output: longOutput },
        },
        50, // limit 50 bytes
      );
      if (completed.type === "commandExecution") {
        expect(completed.output).toHaveLength(50);
        expect(completed.outputTruncated).toBe(true);
      }
    });

    it("binds startAntigravityToolItem and completeAntigravityToolItem to target project cwd", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 5,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "cargo build" } },
        },
        CWD,
      );
      expect(started.type).toBe("commandExecution");
      if (started.type === "commandExecution") {
        expect(started.cwd).toBe(CWD);
      }

      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 5,
          state: "DONE",
          step_type: "tool",
          tool_info: { output: "Finished dev target(s)" },
        },
        64_000,
        CWD,
      );
      expect(completed.type).toBe("commandExecution");
      if (completed.type === "commandExecution") {
        expect(completed.cwd).toBe(CWD);
      }
    });
  });
});
