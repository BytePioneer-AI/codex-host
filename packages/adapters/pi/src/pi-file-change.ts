import type { HostFileChange } from "@codexhost/harness-adapter";
import { createTwoFilesPatch, parsePatch } from "diff";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves a tool path the way Pi's file tools do (`resolveToCwd`), before cwd is applied. */
function piToolPath(nativePath: string): string {
  let normalized = nativePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (
    process.platform === "win32" &&
    normalized.startsWith("/") &&
    !normalized.startsWith("//") &&
    !normalized.includes("\\")
  ) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
    if (match?.[1]) {
      normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
    }
  }
  if (normalized === "~") return os.homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function displayPath(rawPath: string, cwd: string): { path: string; absolute: boolean } | null {
  const nativePath = piToolPath(rawPath);
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

export function fileMutatingKind(toolName: string): "edit" | "write" | null {
  const lower = toolName.toLowerCase().replaceAll(/[_-]/g, "");
  if (
    [
      "edit",
      "editfile",
      "fileedit",
      "strreplace",
      "searchreplace",
      "applypatch",
      "replace",
    ].includes(lower)
  ) {
    return "edit";
  }
  if (["write", "writefile", "filewrite", "create", "createfile"].includes(lower)) return "write";
  return null;
}

function nestedToolString(
  value: unknown,
  keys: readonly string[],
  allowEmpty = false,
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && (allowEmpty || field.length > 0)) return field;
  }
  for (const wrapper of ["input", "arguments", "params", "details"] as const) {
    const nested = nestedToolString(value[wrapper], keys, allowEmpty);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function patchFromResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  for (const key of ["patch", "diff", "unifiedDiff"] as const) {
    const field = result[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  if (isRecord(result.details)) {
    for (const key of ["patch", "diff", "unifiedDiff"] as const) {
      const field = result.details[key];
      if (typeof field === "string" && field.length > 0) return field;
    }
  }
  return undefined;
}

function fileChangeFromPatch(patch: string, cwd: string): HostFileChange[] | null {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(patch);
  } catch {
    return null;
  }
  const file = parsed[0];
  if (parsed.length !== 1 || !file) return null;
  const oldFile = typeof file.oldFileName === "string" ? file.oldFileName : undefined;
  const newFile = typeof file.newFileName === "string" ? file.newFileName : undefined;
  if (!oldFile && !newFile) return null;
  const kind =
    oldFile === "/dev/null" || !oldFile
      ? "add"
      : newFile === "/dev/null" || !newFile
        ? "delete"
        : "update";
  const candidate = kind === "delete" ? oldFile : (newFile ?? oldFile);
  // Pi writes the tool's raw path on both sides; only git-style headers carry a/ and b/.
  const gitStyle =
    (!oldFile || oldFile === "/dev/null" || oldFile.startsWith("a/")) &&
    (!newFile || newFile === "/dev/null" || newFile.startsWith("b/"));
  const rawPath = gitStyle && candidate ? candidate.replace(/^[ab]\//, "") : candidate;
  if (!rawPath || rawPath === "/dev/null") return null;
  const displayed = displayPath(rawPath, cwd);
  if (!displayed) return null;
  return [{ path: displayed.path, kind, unifiedDiff: patch }];
}

function synthesizeFileChange(
  kind: "edit" | "write",
  args: unknown,
  cwd: string,
): HostFileChange[] | null {
  const filePath = nestedToolString(args, ["path", "file_path", "filePath", "file"]);
  if (!filePath) return null;
  const displayed = displayPath(filePath, cwd);
  if (!displayed) return null;
  if (kind === "write") {
    const content = nestedToolString(
      args,
      ["content", "new_string", "newString", "newText", "file_text", "text", "new"],
      true,
    );
    if (content === undefined) return null;
    const oldHeader = "/dev/null";
    const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
    return [
      {
        path: displayed.path,
        kind: "add",
        unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, "", content, "", "", { context: 3 }),
        diffScope: "fragment",
      },
    ];
  }
  // The same argument keys as the Host's fileChangeFromTool, so hostDerivesFileChange agrees with it.
  const oldText = nestedToolString(
    args,
    ["old_string", "oldString", "oldText", "old_text", "old"],
    true,
  );
  const newText = nestedToolString(
    args,
    ["new_string", "newString", "newText", "new_text", "content", "new"],
    true,
  );
  if (oldText === undefined || newText === undefined) return null;
  const oldHeader = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return [
    {
      path: displayed.path,
      kind: "update",
      unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, oldText, newText, "", "", {
        context: 3,
      }),
      diffScope: "fragment",
    },
  ];
}

/**
 * Pi's edit takes `edits: [{ oldText, newText }]`, also as a JSON string, a single object, or
 * legacy top-level `oldText`/`newText` (`prepareEditArguments`). Each replacement becomes its own
 * fragment: without the file content they are not one continuous file version.
 */
function piEditsFileChange(args: unknown, cwd: string): HostFileChange[] | null {
  if (!isRecord(args) || typeof args.path !== "string") return null;
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return null;
    }
  }
  const list: unknown[] = Array.isArray(edits) ? [...edits] : isRecord(edits) ? [edits] : [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    list.push({ oldText: args.oldText, newText: args.newText });
  }
  const replacements = list.filter(
    (edit): edit is { oldText: string; newText: string } =>
      isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string",
  );
  if (replacements.length === 0 || replacements.length !== list.length) return null;
  const displayed = displayPath(args.path, cwd);
  if (!displayed) return null;
  const oldHeader = displayed.absolute ? displayed.path : `a/${displayed.path}`;
  const newHeader = displayed.absolute ? displayed.path : `b/${displayed.path}`;
  return replacements.map((edit) => ({
    path: displayed.path,
    kind: "update",
    unifiedDiff: createTwoFilesPatch(oldHeader, newHeader, edit.oldText, edit.newText, "", "", {
      context: 3,
    }),
    diffScope: "fragment",
  }));
}

function argumentFileChange(
  kind: "edit" | "write",
  args: unknown,
  cwd: string,
): HostFileChange[] | null {
  return (
    (kind === "edit" ? piEditsFileChange(args, cwd) : null) ?? synthesizeFileChange(kind, args, cwd)
  );
}

/**
 * The Host derives a file change from plain edit/write arguments by itself, using the raw path.
 * Paths that Pi resolves differently (`~`, `@`, `file://`, shell drive paths) are not plain, and
 * the Host does not read Pi's `edits[]`.
 */
function hostDerivesFileChange(kind: "edit" | "write", args: unknown, cwd: string): boolean {
  if (kind === "edit" && isRecord(args) && args.edits !== undefined) return false;
  const filePath = nestedToolString(args, ["path", "file_path", "filePath", "file"]);
  return (
    filePath !== undefined &&
    piToolPath(filePath) === filePath &&
    synthesizeFileChange(kind, args, cwd) !== null
  );
}

/**
 * File changes of a completed Pi tool call that the Host cannot derive from its arguments.
 * Shared by live Turns and history so both show the same changes.
 */
export function piToolFileChanges(
  toolName: string,
  args: unknown,
  result: unknown,
  cwd: string,
): HostFileChange[] | null {
  const kind = fileMutatingKind(toolName);
  if (!kind) return null;
  const patch = patchFromResult(result);
  if (patch) {
    const fromPatch = fileChangeFromPatch(patch, cwd);
    if (fromPatch) return fromPatch;
  } else if (hostDerivesFileChange(kind, args, cwd)) {
    return null;
  }
  return argumentFileChange(kind, args, cwd) ?? synthesizeFileChange(kind, result, cwd);
}

/**
 * File changes of tools a Pi tool called through `ctx.executeTool()`. History keeps only their
 * arguments (`nestedCalls`, without results); Pi omits oversized arguments, which cannot be shown.
 */
export function piNestedCallFileChanges(
  nestedCalls: unknown,
  cwd: string,
): { index: number; changes: HostFileChange[] }[] {
  const calls = isRecord(nestedCalls) && Array.isArray(nestedCalls.calls) ? nestedCalls.calls : [];
  const projected: { index: number; changes: HostFileChange[] }[] = [];
  for (const [index, call] of calls.entries()) {
    if (!isRecord(call) || call.status !== "ok" || typeof call.name !== "string") continue;
    const kind = fileMutatingKind(call.name);
    const changes = kind ? argumentFileChange(kind, call.arguments, cwd) : null;
    if (changes) projected.push({ index, changes });
  }
  return projected;
}
