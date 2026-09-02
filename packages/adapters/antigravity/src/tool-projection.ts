import path from "node:path";

import { createTwoFilesPatch } from "diff";

import type {
  HostCommandExecutionItem,
  HostFileChange,
  HostFileChangeItem,
  HostItem,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";
import type { HostItemId, JsonValue } from "@codexhost/shared-contracts";

import type { AntigravityStepUpdateEvent } from "./stream-events.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function boundedText(value: unknown, limit: number): { text: string; truncated: boolean } | null {
  if (value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return null;
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

function normalizeNewlines(str: string): string {
  return str.replaceAll("\r\n", "\n");
}

export function displayPath(
  nativePath: string,
  cwd: string,
): { path: string; absolute: boolean } | null {
  if (
    typeof nativePath !== "string" ||
    nativePath.trim().length === 0 ||
    nativePath.includes("\0") ||
    nativePath.includes("\n") ||
    nativePath.includes("\r")
  ) {
    return null;
  }
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.isAbsolute(nativePath)
    ? path.resolve(nativePath)
    : path.resolve(cwd, nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const inside = relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  const selected = inside ? relative : resolvedPath;
  const normalized = selected.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized === ".") return null;
  return { path: normalized, absolute: !inside };
}

function unwrapParameters(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  if (isRecord(value)) return value;
  return null;
}

function extractString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "string") return val;
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    if (isRecord(record[wrapper])) {
      const nested = extractString(record[wrapper] as Record<string, unknown>, keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function extractBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const val = record[key];
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    if (isRecord(record[wrapper])) {
      const nested = extractBoolean(record[wrapper] as Record<string, unknown>, keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function compactToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[_-]/g, "");
}

const COMPACT_WRITE_TOOLS = new Set(["writetofile", "writefile", "write"]);
const COMPACT_REPLACE_TOOLS = new Set(["replacefilecontent", "replacecontent", "replace"]);
const COMPACT_COMMAND_TOOLS = new Set([
  "runcommand",
  "bash",
  "exec",
  "terminal",
  "run",
  "shell",
  "powershell",
  "command",
]);

export function synthesizeAntigravityFileChange(
  toolName: string,
  params: unknown,
  cwd: string,
): HostFileChange[] | null {
  const record = unwrapParameters(params);
  if (!record) return null;
  const compact = compactToolName(toolName);

  if (COMPACT_WRITE_TOOLS.has(compact)) {
    const rawPath = extractString(record, [
      "TargetFile",
      "targetFile",
      "target_file",
      "filePath",
      "file_path",
      "path",
      "file",
    ]);
    const rawContent = extractString(record, [
      "CodeContent",
      "codeContent",
      "code_content",
      "content",
      "new_string",
      "newString",
      "newText",
      "text",
    ]);
    if (!rawPath || rawContent === undefined) return null;
    const displayed = displayPath(rawPath, cwd);
    if (!displayed) return null;
    const overwrite = extractBoolean(record, ["Overwrite", "overwrite", "overWrite"]) ?? false;
    const kind = overwrite ? "update" : "add";
    const oldHeader =
      kind === "add" ? "/dev/null" : displayed.absolute ? displayed.path : `a/${displayed.path}`;
    const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
    const unifiedDiff = createTwoFilesPatch(
      oldHeader,
      newHeader,
      "",
      normalizeNewlines(rawContent),
      "",
      "",
      { context: 3 },
    );
    return [{ path: displayed.path, kind, unifiedDiff }];
  }

  if (COMPACT_REPLACE_TOOLS.has(compact)) {
    const rawPath = extractString(record, [
      "TargetFile",
      "targetFile",
      "target_file",
      "filePath",
      "file_path",
      "path",
      "file",
    ]);
    const rawTarget = extractString(record, [
      "TargetContent",
      "targetContent",
      "target_content",
      "old_string",
      "oldString",
      "oldText",
      "old_text",
      "old",
    ]);
    const rawReplacement = extractString(record, [
      "ReplacementContent",
      "replacementContent",
      "replacement_content",
      "new_string",
      "newString",
      "newText",
      "new_text",
      "content",
      "new",
    ]);
    if (!rawPath || rawTarget === undefined || rawReplacement === undefined) return null;
    const displayed = displayPath(rawPath, cwd);
    if (!displayed) return null;
    const kind = "update";
    const oldHeader = displayed.absolute ? displayed.path : `a/${displayed.path}`;
    const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
    const unifiedDiff = createTwoFilesPatch(
      oldHeader,
      newHeader,
      normalizeNewlines(rawTarget),
      normalizeNewlines(rawReplacement),
      "",
      "",
      { context: 3 },
    );
    return [{ path: displayed.path, kind, unifiedDiff }];
  }

  return null;
}

export function synthesizeAntigravityCommand(
  toolName: string,
  params: unknown,
): { command: string; cwd?: string } | null {
  const record = unwrapParameters(params);
  if (!record) return null;
  const compact = compactToolName(toolName);

  if (COMPACT_COMMAND_TOOLS.has(compact)) {
    const commandLine = extractString(record, [
      "CommandLine",
      "commandLine",
      "command_line",
      "command",
      "cmd",
      "script",
    ]);
    if (!commandLine || commandLine.trim().length === 0) return null;
    const workingDir = extractString(record, [
      "Cwd",
      "cwd",
      "workingDirectory",
      "working_directory",
    ]);
    return { command: commandLine, ...(workingDir ? { cwd: workingDir } : {}) };
  }

  return null;
}

export function startAntigravityToolItem(
  newItemId: HostItemId,
  step: AntigravityStepUpdateEvent["step_update"],
  cwd?: string,
): HostItem {
  void cwd;
  const toolName = step.tool_name ?? step.tool_info?.name ?? "antigravity.tool";
  const parameters = step.tool_info?.parameters;

  const command = synthesizeAntigravityCommand(toolName, parameters);
  if (command) {
    const item: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: newItemId,
      command: command.command,
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };
    return item;
  }

  const item: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: newItemId,
    toolName,
    arguments: jsonValue(parameters),
  };
  return item;
}

export function completeAntigravityToolItem(
  item: HostItem,
  step: AntigravityStepUpdateEvent["step_update"],
  toolOutputLimit: number,
  cwd?: string,
): HostItem {
  const toolName =
    step.tool_name ??
    step.tool_info?.name ??
    (item.type === "toolExecution" ? item.toolName : "");
  const parameters =
    step.tool_info?.parameters ??
    (item.type === "toolExecution" ? item.arguments : undefined);

  // Only project fileChange when the tool succeeded with DONE state and valid diff evidence
  if (step.state === "DONE" && cwd) {
    const fileChanges = synthesizeAntigravityFileChange(toolName, parameters, cwd);
    if (fileChanges && fileChanges.length > 0) {
      const completed: HostFileChangeItem = {
        type: "fileChange",
        itemId: item.itemId,
        changes: fileChanges,
      };
      return completed;
    }
  }

  const output = boundedText(
    step.tool_info?.output ?? step.tool_info?.error,
    toolOutputLimit,
  );
  const durationMs =
    typeof step.duration_seconds === "number"
      ? Math.max(0, Math.round(step.duration_seconds * 1_000))
      : undefined;

  if (item.type === "commandExecution") {
    const completed: HostCommandExecutionItem = {
      ...item,
      ...(output
        ? {
            output: output.text,
            ...(output.truncated ? { outputTruncated: true } : {}),
          }
        : {}),
      exitCode: step.state === "ERROR" ? 1 : 0,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    return completed;
  }

  if (item.type === "toolExecution" || item.type === "fileChange") {
    const completed: HostToolExecutionItem = {
      type: "toolExecution",
      itemId: item.itemId,
      toolName: item.type === "toolExecution" ? item.toolName : toolName || "antigravity.tool",
      arguments: item.type === "toolExecution" ? item.arguments : jsonValue(parameters),
      ...(output
        ? {
            output: {
              content: [{ type: "text", text: output.text }],
              ...(output.truncated ? { truncated: true } : {}),
            },
          }
        : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    return completed;
  }

  return item;
}
