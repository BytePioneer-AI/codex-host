/**
 * Real file-edit diffs for Antigravity Turns.
 *
 * `agy --output-format stream-json` deliberately strips file content out of
 * `tool_info.parameters`: a `write_to_file` / `replace_file_content` step only
 * carries `TargetFile`. Any patch synthesized from those parameters is
 * therefore empty, which Codex Desktop renders as a phantom `+N -0` card
 * containing nothing but the git header.
 *
 * The authoritative source is agy's own Language Server, which records a
 * `CORTEX_STEP_TYPE_CODE_ACTION` per applied edit carrying a fully typed
 * unified diff. This module reads that trajectory and turns it into the Git
 * unified diff the Host projects onto Codex Desktop's patch UI.
 */

import https from "node:https";

import type { HostFileChange } from "@codexhost/harness-adapter";

import {
  COMPACT_WRITE_TOOLS,
  compactToolName,
  displayPath,
  extractBoolean,
  extractString,
  isAntigravityFileMutatingTool,
  toolTargetFile,
  unwrapParameters,
} from "./tool-projection.js";

const DIFF_CONTEXT_LINES = 3;

type UnifiedDiffLineType = "insert" | "delete" | "unchanged";

interface UnifiedDiffLine {
  text: string;
  type: UnifiedDiffLineType;
}

/** One applied edit, as agy's Language Server recorded it. */
export interface AntigravityCodeAction {
  absolutePath: string;
  createFile: boolean;
  lines: UnifiedDiffLine[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FileReplacement {
  oldText: string | undefined;
  newText: string | undefined;
  startLine: number;
}

function arrayField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  for (const [key, value] of Object.entries(record)) {
    if (
      Array.isArray(value) &&
      keys.some((targetKey) => targetKey.toLowerCase() === key.toLowerCase())
    ) {
      return value;
    }
  }
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    if (isRecord(record[wrapper])) {
      const nested = arrayField(record[wrapper] as Record<string, unknown>, keys);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function startLineField(record: Record<string, unknown>): number {
  const keys = ["StartLine", "startLine", "start_line"];
  for (const [key, value] of Object.entries(record)) {
    if (!keys.some((targetKey) => targetKey.toLowerCase() === key.toLowerCase())) continue;
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function replacementChunks(record: Record<string, unknown>): FileReplacement[] {
  const chunks = arrayField(record, [
    "ReplacementChunks",
    "replacementChunks",
    "replacement_chunks",
  ]);
  if (!chunks) return [];
  const replacements: FileReplacement[] = [];
  for (const chunk of chunks) {
    if (!isRecord(chunk)) continue;
    replacements.push({
      oldText: extractString(chunk, ["TargetContent", "targetContent", "target_content", "Target"]),
      newText: extractString(chunk, [
        "ReplacementContent",
        "replacementContent",
        "replacement_content",
        "Replacement",
      ]),
      startLine: startLineField(chunk),
    });
  }
  return replacements;
}

function textLines(text: string | undefined): string[] {
  if (text === undefined || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function parameterUpdateDiff(
  aPath: string,
  bPath: string,
  replacements: readonly FileReplacement[],
): string | null {
  const hunks: string[] = [];
  for (const { oldText, newText, startLine } of replacements) {
    if (oldText === undefined && newText === undefined) continue;
    if (oldText === newText) continue;
    const oldLines = textLines(oldText);
    const newLines = textLines(newText);
    hunks.push(
      `@@ -${oldLines.length === 0 ? 0 : startLine},${oldLines.length} +${
        newLines.length === 0 ? 0 : startLine
      },${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
    );
  }
  if (hunks.length === 0) return null;
  return [`diff --git ${aPath} ${bPath}`, `--- ${aPath}`, `+++ ${bPath}`, ...hunks, ""].join("\n");
}

function lineType(value: unknown): UnifiedDiffLineType | null {
  switch (value) {
    case "UNIFIED_DIFF_LINE_TYPE_INSERT":
      return "insert";
    case "UNIFIED_DIFF_LINE_TYPE_DELETE":
      return "delete";
    case "UNIFIED_DIFF_LINE_TYPE_UNCHANGED":
      return "unchanged";
    default:
      return null;
  }
}

/**
 * The Language Server encodes an empty line by omitting `text` entirely, so a
 * missing field is content rather than a decoding failure.
 */
function diffLines(value: unknown): UnifiedDiffLine[] | null {
  if (!Array.isArray(value)) return null;
  const lines: UnifiedDiffLine[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const type = lineType(entry.type);
    if (!type) return null;
    const text = entry.text;
    if (text !== undefined && typeof text !== "string") return null;
    lines.push({ text: text ?? "", type });
  }
  return lines;
}

function pathFromFileUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file:///")) return null;
  const withoutScheme = uri.slice("file:///".length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutScheme);
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  // A Windows trajectory yields `file:///D:/x`; a POSIX one yields `file:///x`.
  return /^[a-zA-Z]:/.test(decoded) ? decoded : `/${decoded}`;
}

/** Reads the applied edits out of a `GetCascadeTrajectorySteps` response. */
export function parseAntigravityCodeActions(value: unknown): AntigravityCodeAction[] {
  if (!isRecord(value) || !Array.isArray(value.steps)) return [];
  const actions: AntigravityCodeAction[] = [];
  for (const step of value.steps) {
    if (!isRecord(step) || step.type !== "CORTEX_STEP_TYPE_CODE_ACTION") continue;
    const codeAction = isRecord(step.codeAction) ? step.codeAction : null;
    const actionResult =
      codeAction && isRecord(codeAction.actionResult) ? codeAction.actionResult : null;
    const edit = actionResult && isRecord(actionResult.edit) ? actionResult.edit : null;
    if (!edit) continue;
    const absolutePath = pathFromFileUri(edit.absoluteUri);
    if (!absolutePath) continue;
    const diff = isRecord(edit.diff) ? edit.diff : null;
    const unifiedDiff = diff && isRecord(diff.unifiedDiff) ? diff.unifiedDiff : null;
    const lines = unifiedDiff ? diffLines(unifiedDiff.lines) : null;
    if (!lines) continue;
    actions.push({ absolutePath, createFile: edit.createFile === true, lines });
  }
  return actions;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
}

/**
 * The Language Server reports the whole file with one type per line, so the
 * Git hunks Codex Desktop counts additions and deletions from have to be
 * rebuilt here rather than read off the payload.
 */
function buildHunks(lines: UnifiedDiffLine[]): Hunk[] {
  const changedIndexes = lines.flatMap((line, index) => (line.type === "unchanged" ? [] : [index]));
  if (changedIndexes.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // Old/new line numbers only advance for the sides a line actually belongs to.
  const oldLineNumbers: number[] = [];
  const newLineNumbers: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const line of lines) {
    oldLineNumbers.push(oldLine);
    newLineNumbers.push(newLine);
    if (line.type !== "insert") oldLine += 1;
    if (line.type !== "delete") newLine += 1;
  }

  return ranges.map(({ start, end }) => {
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let index = start; index <= end; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (line.type === "insert") {
        body.push(`+${line.text}`);
        newCount += 1;
      } else if (line.type === "delete") {
        body.push(`-${line.text}`);
        oldCount += 1;
      } else {
        body.push(` ${line.text}`);
        oldCount += 1;
        newCount += 1;
      }
    }
    return {
      oldStart: oldCount === 0 ? 0 : (oldLineNumbers[start] ?? 1),
      oldCount,
      newStart: newCount === 0 ? 0 : (newLineNumbers[start] ?? 1),
      newCount,
      body,
    };
  });
}

/**
 * Projects one recorded edit onto the Host File Change contract, or `null`
 * when the edit changed nothing Codex Desktop could render.
 */
export function codeActionFileChange(
  action: AntigravityCodeAction,
  cwd: string,
): HostFileChange | null {
  const displayed = displayPath(action.absolutePath, cwd);
  if (!displayed) return null;
  const hunks = buildHunks(action.lines);
  if (hunks.length === 0) return null;
  const cleanPath = displayed.path.replace(/^\/+/, "");
  const aPath = `a/${cleanPath}`;
  const bPath = `b/${cleanPath}`;
  const kind = action.createFile ? "add" : "update";
  const body = hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    ...hunk.body,
  ]);
  const unifiedDiff = [
    `diff --git ${aPath} ${bPath}`,
    `--- ${kind === "add" ? "/dev/null" : aPath}`,
    `+++ ${bPath}`,
    ...body,
    "",
  ].join("\n");
  return { path: displayed.path, kind, unifiedDiff };
}

export function fileChangeFromAntigravityParameters(
  toolName: string,
  params: unknown,
  cwd: string,
): HostFileChange | null {
  if (!isAntigravityFileMutatingTool(toolName)) return null;
  const rawPath = toolTargetFile(toolName, params);
  if (!rawPath) return null;
  const displayed = displayPath(rawPath, cwd);
  if (!displayed) return null;

  const record = unwrapParameters(params);
  if (!record) return null;

  const cleanPath = displayed.path.replace(/^\/+/, "");
  const aPath = `a/${cleanPath}`;
  const bPath = `b/${cleanPath}`;

  const compact = compactToolName(toolName);
  const isWrite = COMPACT_WRITE_TOOLS.has(compact);

  if (isWrite) {
    // An overwrite has no trustworthy old side in the stream parameters. Keep
    // the ordinary tool card rather than presenting the result as a new file.
    if (extractBoolean(record, ["Overwrite", "overwrite"]) === true) return null;
    const content = extractString(record, [
      "CodeContent",
      "codeContent",
      "code_content",
      "Content",
      "content",
      "new_string",
      "newString",
      "newText",
      "text",
    ]);
    if (content === undefined) return null;
    const rawLines = content.split(/\r?\n/);
    if (content.endsWith("\n") && rawLines.length > 1 && rawLines.at(-1) === "") {
      rawLines.pop();
    }
    const hunks = buildHunks(rawLines.map((text) => ({ text, type: "insert" })));
    if (hunks.length === 0) return null;
    const body = hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      ...hunk.body,
    ]);
    const unifiedDiff = [
      `diff --git ${aPath} ${bPath}`,
      "--- /dev/null",
      `+++ ${bPath}`,
      ...body,
      "",
    ].join("\n");
    return { path: displayed.path, kind: "add", unifiedDiff };
  }

  const replacements = replacementChunks(record);
  if (replacements.length === 0) {
    replacements.push({
      oldText: extractString(record, [
        "TargetContent",
        "targetContent",
        "target_content",
        "Target",
        "target",
        "old_string",
        "oldString",
        "oldText",
        "old_text",
      ]),
      newText: extractString(record, [
        "ReplacementContent",
        "replacementContent",
        "replacement_content",
        "Replacement",
        "replacement",
        "new_string",
        "newString",
        "newText",
        "new_text",
        "content",
      ]),
      startLine: startLineField(record),
    });
  }
  const unifiedDiff = parameterUpdateDiff(aPath, bPath, replacements);
  if (!unifiedDiff) return null;

  return { path: displayed.path, kind: "update", diffScope: "fragment", unifiedDiff };
}

export function requestAntigravityTrajectorySteps(
  port: number,
  conversationId: string,
  timeoutMs: number,
  csrfToken?: string,
): Promise<AntigravityCodeAction[]> {
  const token = csrfToken?.trim() || process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps",
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          "connect-protocol-version": "1",
          ...(token ? { "x-codeium-csrf-token": token } : {}),
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve([]);
          try {
            resolve(parseAntigravityCodeActions(JSON.parse(body)));
          } catch {
            resolve([]);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve([]));
    request.end(JSON.stringify({ cascadeId: conversationId }));
  });
}
