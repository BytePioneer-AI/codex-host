import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTwoFilesPatch } from "diff";

import type { HostFileChange } from "@codexhost/harness-adapter";

export const DEFAULT_KIRO_FILE_CHANGE_TEXT_LIMIT = 4 * 1024 * 1024;
const MAX_KIRO_FILE_CHANGES_PER_TOOL = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveFilePath(candidate: string): string | null {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  if (candidate.includes("\0") || candidate.includes("\n") || candidate.includes("\r")) {
    return null;
  }
  try {
    if (candidate.startsWith("file:")) {
      return path.resolve(fileURLToPath(new URL(candidate)));
    }
    return path.resolve(candidate);
  } catch {
    try {
      const withoutScheme = candidate.replace(/^file:\/\/\/?/iu, "");
      return path.resolve(decodeURIComponent(withoutScheme));
    } catch {
      return null;
    }
  }
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
  remainingTextBytes: number,
): { change: HostFileChange; textBytes: number } | null {
  if (typeof value.path !== "string") return null;
  const resolvedPath = resolveFilePath(value.path);
  if (!resolvedPath) return null;

  if (
    (typeof value.oldText !== "string" && value.oldText !== null) ||
    typeof value.newText !== "string"
  ) {
    return null;
  }

  const oldText = value.oldText;
  const newText = value.newText;

  // Filter non-modifications and empty placeholders
  if (
    (typeof oldText === "string" && oldText === newText) ||
    (oldText === null && newText === "")
  ) {
    return null;
  }

  const textBytes = Buffer.byteLength(oldText ?? "", "utf8") + Buffer.byteLength(newText, "utf8");
  if (textBytes > remainingTextBytes) return null;

  const displayed = displayPath(resolvedPath, cwd);
  if (!displayed) return null;

  const kind = oldText === null ? "add" : "update";
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

export function projectKiroFileChanges(
  content: unknown,
  cwd: string,
  textLimit = DEFAULT_KIRO_FILE_CHANGE_TEXT_LIMIT,
): HostFileChange[] | null {
  if (!Number.isSafeInteger(textLimit) || textLimit <= 0 || !Array.isArray(content)) return null;

  const candidates: Record<string, unknown>[] = [];
  for (const entry of content) {
    if (isRecord(entry) && entry.type === "diff") candidates.push(entry);
  }
  if (candidates.length === 0 || candidates.length > MAX_KIRO_FILE_CHANGES_PER_TOOL) return null;

  const changes: HostFileChange[] = [];
  const paths = new Set<string>();
  let textBytes = 0;

  for (const candidate of candidates) {
    const projected = projectDiff(candidate, cwd, textLimit - textBytes);
    if (!projected || paths.has(projected.change.path)) return null;
    textBytes += projected.textBytes;
    paths.add(projected.change.path);
    changes.push(projected.change);
  }

  return changes.length > 0 ? changes : null;
}
