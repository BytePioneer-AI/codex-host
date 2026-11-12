import { existsSync } from "node:fs";
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

/** Capture the files present in the cache cohort used by this backend generation. */
export function captureCodexRuntimeFiles(executable: string): string[] {
  const files = [executable];
  if (process.platform === "win32")
    files.push(path.join(path.dirname(executable), "codex-code-mode-host.exe"));
  return files.filter((file) => existsSync(file));
}

export function assertCodexRuntimeFilesPresent(files: readonly string[]): void {
  if (files.some((file) => !existsSync(file))) throw new CodexRuntimeFilesRemovedError();
}
