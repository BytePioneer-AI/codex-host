import fs from "node:fs";
import path from "node:path";

function missingPath(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

function hasDotPathSegment(value: string): boolean {
  const segments = process.platform === "win32" ? value.split(/[\\/]+/) : value.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

function canonicalDirectoryPath(value: string): string | undefined {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(candidate), ...missingSegments);
    } catch (error) {
      if (!missingPath(error)) return undefined;
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function canonicalFilePath(value: string): string | undefined {
  const absolute = path.resolve(value);
  const parent = canonicalDirectoryPath(path.dirname(absolute));
  return parent ? path.join(parent, path.basename(absolute)) : undefined;
}

function pathIsWithin(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(root, candidate);
  return (
    (allowRoot && relative === "") ||
    (relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function verifiedOpenCodeWorktree(
  sessionDirectory: string,
  paths: { directory: string; worktree: string },
): string | undefined {
  if (
    !paths ||
    typeof paths !== "object" ||
    typeof sessionDirectory !== "string" ||
    typeof paths.directory !== "string" ||
    typeof paths.worktree !== "string" ||
    hasDotPathSegment(sessionDirectory) ||
    hasDotPathSegment(paths.directory) ||
    hasDotPathSegment(paths.worktree) ||
    !path.isAbsolute(sessionDirectory) ||
    !path.isAbsolute(paths.directory) ||
    !path.isAbsolute(paths.worktree)
  ) {
    return undefined;
  }
  const session = canonicalDirectoryPath(sessionDirectory);
  const directory = canonicalDirectoryPath(paths.directory);
  const worktree = canonicalDirectoryPath(paths.worktree);
  if (
    !session ||
    !directory ||
    !worktree ||
    session !== directory ||
    !pathIsWithin(worktree, directory, true)
  ) {
    return undefined;
  }
  return worktree;
}

export function openCodeFileIdentity(file: string, worktree: string): string | undefined {
  if (
    typeof file !== "string" ||
    typeof worktree !== "string" ||
    hasDotPathSegment(file) ||
    hasDotPathSegment(worktree) ||
    !path.isAbsolute(worktree) ||
    !file ||
    file.includes("\0") ||
    file.includes("\n") ||
    file.includes("\r")
  ) {
    return undefined;
  }
  const candidate = canonicalFilePath(path.isAbsolute(file) ? file : path.resolve(worktree, file));
  return candidate && pathIsWithin(worktree, candidate, false) ? candidate : undefined;
}
