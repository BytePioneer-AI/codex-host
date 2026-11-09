import { hostItemIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  projectQwenCodeToolOutput,
  qwenCodeToolArguments,
  qwenCodeToolName,
  startQwenCodeToolItem,
} from "../src/qwen-tool-output.js";

const itemId = () => hostItemIdSchema.parse("test-item");

describe("Qwen Code tool-output projection", () => {
  it("prefers ACP content text over raw output", () => {
    const projection = projectQwenCodeToolOutput(
      [{ type: "text", text: "from content" }],
      "from raw output",
    );
    expect(projection.output?.content).toEqual([{ type: "text", text: "from content" }]);
  });

  it("falls back to raw output strings and record shapes", () => {
    expect(projectQwenCodeToolOutput([], "plain output")?.output?.content).toEqual([
      { type: "text", text: "plain output" },
    ]);
    expect(
      projectQwenCodeToolOutput([], { output: "record output", exit_code: 3 })?.output?.content,
    ).toEqual([{ type: "text", text: "record output" }]);
  });

  it("extracts exit codes from both naming conventions", () => {
    expect(projectQwenCodeToolOutput([], { exit_code: 3 })?.exitCode).toBe(3);
    expect(projectQwenCodeToolOutput([], { exitCode: null })?.exitCode).toBeNull();
  });

  it("truncates oversized output and flags it", () => {
    const text = "x".repeat(100);
    const projection = projectQwenCodeToolOutput([{ type: "text", text }], undefined, 40);
    expect(projection.output?.content).toEqual([{ type: "text", text: "x".repeat(40) }]);
    expect(projection.output?.truncated).toBe(true);
  });

  it("projects images within the remaining byte budget", () => {
    const base64 = "aGk=";
    const projection = projectQwenCodeToolOutput(
      [
        { type: "text", text: "x".repeat(30) },
        { type: "image", mimeType: "image/png", data: base64 },
      ],
      undefined,
      40,
    );
    expect(projection.output?.content).toEqual([
      { type: "text", text: "x".repeat(30) },
      { type: "image", mimeType: "image/png", base64Data: base64 },
    ]);
  });

  it("maps execute calls to command items with a cwd fallback", () => {
    const item = startQwenCodeToolItem({
      itemId: itemId(),
      kind: "execute",
      title: "Run git status",
      rawInput: { command: "git status" },
      cwd: "/session/cwd",
    });
    expect(item).toEqual({
      type: "commandExecution",
      itemId: item.itemId,
      command: "git status",
      cwd: "/session/cwd",
    });
    const withRawCwd = startQwenCodeToolItem({
      itemId: itemId(),
      kind: "execute",
      title: "Run git status",
      rawInput: { command: "git status", cwd: "/raw/cwd" },
      cwd: "/session/cwd",
    });
    expect(withRawCwd).toMatchObject({ cwd: "/raw/cwd" });
  });

  it("derives tool names and safe arguments", () => {
    expect(qwenCodeToolName("edit", "Replace file")).toBe("edit");
    expect(qwenCodeToolName(undefined, "Replace file")).toBe("Replace file");
    expect(qwenCodeToolName(undefined, undefined)).toBe("Qwen Code Tool");
    expect(qwenCodeToolArguments({ file_path: "/tmp/a" })).toEqual({ file_path: "/tmp/a" });
    expect(qwenCodeToolArguments(undefined)).toEqual({});
    expect(qwenCodeToolArguments(() => "invalid")).toEqual({});
  });
});
