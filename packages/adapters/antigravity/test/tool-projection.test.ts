import path from "node:path";

import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  completeAntigravityToolItem,
  displayPath,
  startAntigravityToolItem,
  synthesizeAntigravityCommand,
  synthesizeAntigravityFileChange,
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

  describe("synthesizeAntigravityFileChange", () => {
    describe("write_to_file", () => {
      it("projects new file creation as an add fileChange with unified diff", () => {
        const changes = synthesizeAntigravityFileChange(
          "write_to_file",
          {
            TargetFile: "src/hello.ts",
            CodeContent: "console.log('hello world');\n",
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.path).toBe("src/hello.ts");
        expect(change.kind).toBe("add");
        expect(change.unifiedDiff).toContain("--- /dev/null");
        expect(change.unifiedDiff).toContain("+++ b/src/hello.ts");
        expect(change.unifiedDiff).toContain("+console.log('hello world');");
      });

      it("projects overwrite as an update fileChange with unified diff", () => {
        const changes = synthesizeAntigravityFileChange(
          "write_to_file",
          {
            targetFile: "src/hello.ts",
            codeContent: "console.log('updated content');\n",
            overwrite: true,
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.path).toBe("src/hello.ts");
        expect(change.kind).toBe("update");
        expect(change.unifiedDiff).toContain("--- a/src/hello.ts");
        expect(change.unifiedDiff).toContain("+++ b/src/hello.ts");
        expect(change.unifiedDiff).toContain("+console.log('updated content');");
      });

      it("supports overwrite as string 'true'", () => {
        const changes = synthesizeAntigravityFileChange(
          "write_to_file",
          {
            TargetFile: "src/config.json",
            CodeContent: "{}",
            Overwrite: "true",
          },
          CWD,
        );
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.kind).toBe("update");
      });

      it("handles empty file content creation", () => {
        const changes = synthesizeAntigravityFileChange(
          "write_to_file",
          { TargetFile: "empty.txt", CodeContent: "" },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.kind).toBe("add");
      });

      it("normalizes Windows CRLF newlines", () => {
        const changes = synthesizeAntigravityFileChange(
          "write_to_file",
          {
            TargetFile: "crlf.txt",
            CodeContent: "line1\r\nline2\r\n",
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.unifiedDiff).not.toContain("\r");
        expect(change.unifiedDiff).toContain("+line1\n+line2");
      });

      it("supports JSON stringified parameters", () => {
        const jsonParams = JSON.stringify({
          TargetFile: "data.txt",
          CodeContent: "hello from json",
        });
        const changes = synthesizeAntigravityFileChange("write_to_file", jsonParams, CWD);
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.path).toBe("data.txt");
      });

      it("returns null when TargetFile or CodeContent is missing", () => {
        expect(
          synthesizeAntigravityFileChange("write_to_file", { TargetFile: "foo.ts" }, CWD),
        ).toBeNull();
        expect(
          synthesizeAntigravityFileChange("write_to_file", { CodeContent: "foo" }, CWD),
        ).toBeNull();
      });
    });

    describe("replace_file_content", () => {
      it("projects content replacement as an update fileChange with diff hunks", () => {
        const changes = synthesizeAntigravityFileChange(
          "replace_file_content",
          {
            TargetFile: "src/app.ts",
            TargetContent: "const PORT = 3000;\n",
            ReplacementContent: "const PORT = 8080;\n",
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.path).toBe("src/app.ts");
        expect(change.kind).toBe("update");
        expect(change.unifiedDiff).toContain("--- a/src/app.ts");
        expect(change.unifiedDiff).toContain("+++ b/src/app.ts");
        expect(change.unifiedDiff).toContain("-const PORT = 3000;");
        expect(change.unifiedDiff).toContain("+const PORT = 8080;");
      });

      it("supports camelCase and snake_case parameter variants", () => {
        const changes = synthesizeAntigravityFileChange(
          "replace_file_content",
          {
            target_file: "test.py",
            old_string: "def foo(): pass",
            new_string: "def foo(): return 42",
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.path).toBe("test.py");
        expect(change.unifiedDiff).toContain("-def foo(): pass");
        expect(change.unifiedDiff).toContain("+def foo(): return 42");
      });

      it("safely handles identical/empty diff replacement without throwing", () => {
        const changes = synthesizeAntigravityFileChange(
          "replace_file_content",
          {
            TargetFile: "same.txt",
            TargetContent: "same text",
            ReplacementContent: "same text",
          },
          CWD,
        );
        expect(changes).not.toBeNull();
        const [change] = changes ?? [];
        if (!change) throw new Error("Expected change");
        expect(change.kind).toBe("update");
      });

      it("returns null when required parameters are missing", () => {
        expect(
          synthesizeAntigravityFileChange(
            "replace_file_content",
            { TargetFile: "a.ts", TargetContent: "foo" },
            CWD,
          ),
        ).toBeNull();
        expect(
          synthesizeAntigravityFileChange(
            "replace_file_content",
            { TargetFile: "a.ts", ReplacementContent: "bar" },
            CWD,
          ),
        ).toBeNull();
        expect(
          synthesizeAntigravityFileChange(
            "replace_file_content",
            { TargetContent: "foo", ReplacementContent: "bar" },
            CWD,
          ),
        ).toBeNull();
      });
    });

    it("returns null for non-file tools", () => {
      expect(
        synthesizeAntigravityFileChange("run_command", { CommandLine: "npm test" }, CWD),
      ).toBeNull();
      expect(synthesizeAntigravityFileChange("view_file", { AbsolutePath: "/a/b" }, CWD)).toBeNull();
      expect(synthesizeAntigravityFileChange("list_dir", { DirectoryPath: "/a" }, CWD)).toBeNull();
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
      expect(
        synthesizeAntigravityCommand("runCommand", { commandLine: "pytest" }),
      ).toEqual({ command: "pytest" });
      expect(
        synthesizeAntigravityCommand("bash", { command: "cargo build" }),
      ).toEqual({ command: "cargo build" });
      expect(
        synthesizeAntigravityCommand("terminal", { cmd: "echo 1" }),
      ).toEqual({ command: "echo 1" });
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
    it("creates HostToolExecutionItem for write_to_file during start phase", () => {
      const item = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            parameters: {
              TargetFile: "index.js",
              CodeContent: "console.log('hi');",
            },
          },
        },
        CWD,
      );
      expect(item.type).toBe("toolExecution");
      if (item.type === "toolExecution") {
        expect(item.toolName).toBe("write_to_file");
        expect(item.arguments).toEqual({
          TargetFile: "index.js",
          CodeContent: "console.log('hi');",
        });
      }
    });

    it("creates HostToolExecutionItem for replace_file_content during start phase", () => {
      const item = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "replace_file_content",
          tool_info: {
            parameters: {
              TargetFile: "index.js",
              TargetContent: "hi",
              ReplacementContent: "hello",
            },
          },
        },
        CWD,
      );
      expect(item.type).toBe("toolExecution");
      if (item.type === "toolExecution") {
        expect(item.toolName).toBe("replace_file_content");
      }
    });

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
    it("completes file tool with fileChange on DONE state and valid parameters", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            parameters: { TargetFile: "a.ts", CodeContent: "const x = 1;" },
          },
        },
        CWD,
      );
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 1,
          state: "DONE",
          step_type: "tool",
          duration_seconds: 0.15,
          tool_info: {
            parameters: { TargetFile: "a.ts", CodeContent: "const x = 1;" },
            output: "File written successfully.",
          },
        },
        64_000,
        CWD,
      );
      expect(completed.type).toBe("fileChange");
      if (completed.type === "fileChange") {
        expect(completed.changes).toHaveLength(1);
        expect(completed.changes[0]?.path).toBe("a.ts");
      }
    });

    it("completes file tool with toolExecution (not fileChange) on ERROR state", () => {
      const started = startAntigravityToolItem(
        newItemId(),
        {
          conversation_id: "c1",
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            parameters: { TargetFile: "a.ts", CodeContent: "const x = 1;" },
          },
        },
        CWD,
      );
      const completed = completeAntigravityToolItem(
        started,
        {
          conversation_id: "c1",
          step_index: 1,
          state: "ERROR",
          step_type: "tool",
          duration_seconds: 0.15,
          tool_info: {
            parameters: { TargetFile: "a.ts", CodeContent: "const x = 1;" },
            error: "EACCES: permission denied",
          },
        },
        64_000,
        CWD,
      );
      expect(completed.type).toBe("toolExecution");
      if (completed.type === "toolExecution") {
        expect(completed.output?.content).toEqual([
          { type: "text", text: "EACCES: permission denied" },
        ]);
      }
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
  });
});
