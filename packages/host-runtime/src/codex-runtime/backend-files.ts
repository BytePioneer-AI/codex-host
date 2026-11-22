import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Fixed text is safe to carry in a WebSocket close reason (under 123 UTF-8 bytes).
export const CODEX_RUNTIME_REMOVED_MESSAGE =
  "Codex runtime files removed. Run codexhost stop, then restart CodexHost. Stopping interrupts Host tasks.";

export class CodexRuntimeFilesRemovedError extends Error {
  constructor() {
    super(CODEX_RUNTIME_REMOVED_MESSAGE);
    this.name = "CodexRuntimeFilesRemovedError";
  }
}

export interface CodexRuntimeFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function runtimeFileIdentity(file: string): CodexRuntimeFile | undefined {
  try {
    // Follow symlinks: the identity belongs to the target that Codex executes.
    const { dev, ino, size, mtimeMs } = statSync(file);
    return { path: file, dev, ino, size, mtimeMs };
  } catch {
    return undefined;
  }
}

/** Capture the files present in the cache cohort used by this backend generation. */
export function captureCodexRuntimeFiles(executable: string): CodexRuntimeFile[] {
  const files = [executable];
  if (process.platform === "win32")
    files.push(path.join(path.dirname(executable), "codex-code-mode-host.exe"));
  return files.map(runtimeFileIdentity).filter((file) => file !== undefined);
}

export function assertCodexRuntimeFilesPresent(files: readonly CodexRuntimeFile[]): void {
  if (files.some((file) => !existsSync(file.path))) throw new CodexRuntimeFilesRemovedError();
}

export function codexRuntimeFilesChanged(files: readonly CodexRuntimeFile[]): boolean {
  let changed = false;
  for (const file of files) {
    const current = runtimeFileIdentity(file.path);
    // A missing cohort member is deletion, not an upgrade.
    if (!current) return false;
    changed ||=
      current.dev !== file.dev ||
      current.ino !== file.ino ||
      current.size !== file.size ||
      current.mtimeMs !== file.mtimeMs;
  }
  return changed;
}
