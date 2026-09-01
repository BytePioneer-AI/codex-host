import { Buffer } from "node:buffer";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import type { HostFileChange } from "@codexhost/harness-adapter";

export const DEFAULT_QWEN_CODE_FILE_CHANGE_TEXT_LIMIT = 4 * 1024 * 1024;
const MAX_QWEN_CODE_FILE_CHANGES_PER_TOOL = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiffPathText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

/**
 * Qwen Code reports the edited file as a bare basename (`fileName`) while the
 * tool call's own `file_path` argument stays absolute, so a relative diff path
 * is resolved against that argument instead of the session cwd (the basename
 * has already lost the subdirectory).
 */
function nativeDiffPath(diffPath: unknown, rawInput: unknown): string | null {
  if (!validDiffPathText(diffPath)) return null;
  if (path.isAbsolute(diffPath)) return diffPath;
  if (isRecord(rawInput) && typeof rawInput.file_path === "string") {
    const filePath = rawInput.file_path;
    if (path.isAbsolute(filePath) && !filePath.includes("\0")) return filePath;
  }
  return null;
}

function displayPath(nativePath: string, cwd: string): { path: string; absolute: boolean } | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedPath = path.resolve(nativePath);
  const relative = path.relative(resolvedCwd, resolvedPath);
  const inside = relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  const selected = inside ? relative : resolvedPath;
  const normalized = selected.replaceAll("\\", "/");
  if (normalized.length === 0 || normalized === ".") return null;
  return { path: normalized, absolute: !inside };
}

function projectDiff(
  value: Record<string, unknown>,
  cwd: string,
  rawInput: unknown,
  remainingTextBytes: number,
): { change: HostFileChange; textBytes: number } | null {
  const nativePath = nativeDiffPath(value.path, rawInput);
  if (
    nativePath === null ||
    (typeof value.oldText !== "string" && value.oldText !== null) ||
    typeof value.newText !== "string"
  ) {
    return null;
  }
  const oldText = value.oldText;
  const newText = value.newText;
  if (oldText === newText || (oldText === null && newText === "")) {
    return null;
  }
  const textBytes = Buffer.byteLength(oldText ?? "", "utf8") + Buffer.byteLength(newText, "utf8");
  if (textBytes > remainingTextBytes) return null;
  const displayed = displayPath(nativePath, cwd);
  if (!displayed) return null;
  // The CLI always sends `oldText` as a string, using "" for files it just
  // created, so both null and "" mark an add.
  const kind = oldText === null || oldText === "" ? "add" : "update";
  const oldHeader =
    kind === "add" ? "/dev/null" : displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return {
    change: {
      path: displayed.path,
      kind,
      unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, oldText ?? "", newText, "", "", {
        context: 3,
      }),
    },
    textBytes,
  };
}

export function projectQwenCodeFileChanges(
  content: unknown,
  cwd: string,
  rawInput?: unknown,
  textLimit = DEFAULT_QWEN_CODE_FILE_CHANGE_TEXT_LIMIT,
): HostFileChange[] | null {
  if (!Number.isSafeInteger(textLimit) || textLimit <= 0 || !Array.isArray(content)) return null;
  const candidates: Record<string, unknown>[] = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "diff") candidates.push(entry);
  }
  if (candidates.length === 0 || candidates.length > MAX_QWEN_CODE_FILE_CHANGES_PER_TOOL)
    return null;

  const changes: HostFileChange[] = [];
  const paths = new Set<string>();
  let textBytes = 0;
  for (const candidate of candidates) {
    const projected = projectDiff(candidate, cwd, rawInput, textLimit - textBytes);
    if (!projected || paths.has(projected.change.path)) return null;
    textBytes += projected.textBytes;
    paths.add(projected.change.path);
    changes.push(projected.change);
  }
  return changes;
}
