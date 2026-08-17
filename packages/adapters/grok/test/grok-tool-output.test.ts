import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  applyGrokToolProjection,
  grokCommand,
  grokToolName,
  projectGrokToolOutput,
  startGrokToolItem,
} from "../src/grok-tool-output.js";

const itemId = (value: string) => hostItemIdSchema.parse(value);

describe("Grok tool output projection", () => {
  it("maps verified execute tools to Command Execution", () => {
    expect(grokCommand("bash", undefined, { command: "npm test" })).toBe("npm test");
    expect(grokCommand("run_terminal_command", undefined, { command: "ls" })).toBe("ls");
    expect(grokCommand("custom", "execute", { command: "pwd" })).toBe("pwd");
    expect(grokCommand("custom", undefined, { variant: "Bash", command: "echo hi" })).toBe(
      "echo hi",
    );
    expect(grokCommand("read_file", undefined, { command: "not a shell" })).toBeUndefined();
    expect(grokCommand("bash", undefined, { path: "a.txt" })).toBeUndefined();
  });

  it("starts bash as Command Execution and other tools as Generic Tools", () => {
    expect(
      startGrokToolItem({
        itemId: itemId("item-1"),
        name: "bash",
        rawInput: { command: "npm test" },
        cwd: "/workspace",
      }),
    ).toMatchObject({
      type: "commandExecution",
      command: "npm test",
      cwd: "/workspace",
    });
    expect(
      startGrokToolItem({
        itemId: itemId("item-2"),
        name: "read_file",
        title: "Read a.txt",
        rawInput: { target_file: "/workspace/a.txt" },
        cwd: "/workspace",
      }),
    ).toMatchObject({
      type: "toolExecution",
      toolName: "read_file",
      arguments: { target_file: "/workspace/a.txt" },
    });
  });

  it("prefers ACP text content over typed raw output", () => {
    expect(
      projectGrokToolOutput([{ type: "content", content: { type: "text", text: "file body" } }], {
        type: "ReadFile",
        content: "ignored",
      }),
    ).toEqual({
      output: { content: [{ type: "text", text: "file body" }] },
    });
  });

  it("extracts ListDir and Grep text from typed raw output without dumping JSON", () => {
    expect(
      projectGrokToolOutput(undefined, {
        type: "ListDir",
        content: "a.ts\nb.ts",
        absolute_root_path: "/workspace",
      }),
    ).toEqual({
      output: { content: [{ type: "text", text: "a.ts\nb.ts" }] },
    });
    expect(projectGrokToolOutput(undefined, { type: "GrepSearch", match_count: 3 })).toEqual({
      output: { content: [{ type: "text", text: "found 3 matches" }] },
    });
    expect(
      projectGrokToolOutput(undefined, { type: "WebSearch", results: [{ title: "x" }] }),
    ).toEqual({});
  });

  it("decodes Bash bytes and exit code without using object String()", () => {
    expect(
      projectGrokToolOutput(undefined, {
        type: "Bash",
        output: [...Buffer.from("passed", "utf8")],
        exit_code: 0,
      }),
    ).toEqual({
      output: { content: [{ type: "text", text: "passed" }] },
      exitCode: 0,
    });
    expect(String({ type: "Bash", output: "passed" })).toBe("[object Object]");
  });

  it("keeps Generic Tool output structured and Command output as text", () => {
    const projection = projectGrokToolOutput(
      [{ type: "content", content: { type: "text", text: "contents" } }],
      undefined,
    );
    expect(
      applyGrokToolProjection(
        {
          type: "toolExecution",
          itemId: itemId("tool-1"),
          toolName: "read_file",
          arguments: { target_file: "a.txt" },
        },
        projection,
      ),
    ).toMatchObject({
      output: { content: [{ type: "text", text: "contents" }] },
    });
    expect(
      applyGrokToolProjection(
        {
          type: "commandExecution",
          itemId: itemId("cmd-1"),
          command: "npm test",
          cwd: "/workspace",
        },
        { output: { content: [{ type: "text", text: "passed" }] }, exitCode: 0 },
      ),
    ).toMatchObject({
      output: "passed",
      exitCode: 0,
    });
  });

  it("uses the Tool name when present and the title otherwise", () => {
    expect(grokToolName("bash", "Run tests")).toBe("bash");
    expect(grokToolName(undefined, "Run tests")).toBe("Run tests");
    expect(grokToolName(undefined, undefined)).toBe("Grok Tool");
  });
});
