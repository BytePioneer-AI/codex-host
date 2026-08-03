import path from "node:path";

import { z } from "zod";

export interface ClaudeStructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ClaudeNativeFileChange {
  path: string;
  kind: "add" | "update";
  hunks: ClaudeStructuredPatchHunk[];
}

export interface ClaudeProjectedFileChange {
  path: string;
  kind: "add" | "update";
  unifiedDiff: string;
}

const hunkSchema = z
  .object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validNativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function countLines(lines: string[], prefixes: ReadonlySet<string>): number {
  return lines.filter((line) => line.length > 0 && prefixes.has(line[0] as string)).length;
}

function validHunk(value: unknown): ClaudeStructuredPatchHunk | null {
  const parsed = hunkSchema.safeParse(value);
  if (!parsed.success) return null;
  const hunk = parsed.data;
  if (
    hunk.lines.some(
      (line) => line.length === 0 || ![" ", "+", "-", "\\"].includes(line[0] as string),
    )
  ) {
    return null;
  }
  if (countLines(hunk.lines, new Set([" ", "-"])) !== hunk.oldLines) return null;
  if (countLines(hunk.lines, new Set([" ", "+"])) !== hunk.newLines) return null;
  return hunk;
}

export function parseClaudeNativeFileChange(
  toolName: string,
  value: unknown,
): ClaudeNativeFileChange | null {
  if ((toolName !== "Edit" && toolName !== "Write") || !isRecord(value)) return null;
  if (!validNativePath(value.filePath) || !Array.isArray(value.structuredPatch)) return null;
  const hunks = value.structuredPatch.map(validHunk);
  if (hunks.length === 0 || hunks.some((hunk) => hunk === null)) return null;
  if (toolName === "Write" && value.type !== "create" && value.type !== "update") return null;
  return {
    path: value.filePath,
    kind: toolName === "Write" && value.type === "create" ? "add" : "update",
    hunks: hunks as ClaudeStructuredPatchHunk[],
  };
}

function displayPath(nativePath: string, cwd: string): string | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.isAbsolute(nativePath)
    ? path.resolve(nativePath)
    : path.resolve(cwd, nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const selected =
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      ? relative
      : resolvedPath;
  const normalized = selected.replaceAll("\\", "/");
  return validNativePath(normalized) && normalized !== "." ? normalized : null;
}

export function projectClaudeFileChange(
  value: ClaudeNativeFileChange,
  cwd: string,
): ClaudeProjectedFileChange | null {
  const normalizedPath = displayPath(value.path, cwd);
  if (!normalizedPath) return null;
  const body = value.hunks.flatMap((hunk) => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ]);
  const absoluteDisplayPath = path.posix.isAbsolute(normalizedPath);
  const oldHeader =
    value.kind === "add"
      ? "/dev/null"
      : absoluteDisplayPath
        ? normalizedPath
        : `a/${normalizedPath}`;
  const newHeader = absoluteDisplayPath ? normalizedPath : `b/${normalizedPath}`;
  const unifiedDiff = [`--- ${oldHeader}`, `+++ ${newHeader}`, ...body, ""].join("\n");
  return { path: normalizedPath, kind: value.kind, unifiedDiff };
}
