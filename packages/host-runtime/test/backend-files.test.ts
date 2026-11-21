import { mkdtemp, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  assertCodexRuntimeFilesPresent,
  captureCodexRuntimeFiles,
  codexRuntimeFilesChanged,
  CodexRuntimeFilesRemovedError,
} from "../src/codex-runtime/backend-files.js";

it.skipIf(process.platform === "win32")(
  "distinguishes an atomically replaced symlink target from a deleted target",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-runtime-files-"));
    try {
      const executable = path.join(directory, "codex");
      const target = path.join(directory, "target");
      const replacement = path.join(directory, "replacement");
      const timestamp = 1_750_000_000;
      await writeFile(target, "original");
      await writeFile(replacement, "upgraded");
      await utimes(target, timestamp, timestamp);
      await utimes(replacement, timestamp, timestamp);
      await symlink(target, executable);
      const files = captureCodexRuntimeFiles(executable);
      expect(codexRuntimeFilesChanged(files)).toBe(false);

      await rename(replacement, target);
      expect(codexRuntimeFilesChanged(files)).toBe(true);
      expect(() => assertCodexRuntimeFilesPresent(files)).not.toThrow();

      await rm(target);
      expect(codexRuntimeFilesChanged(files)).toBe(false);
      expect(() => assertCodexRuntimeFilesPresent(files)).toThrow(CodexRuntimeFilesRemovedError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
