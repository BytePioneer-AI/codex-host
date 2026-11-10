import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DelegationControlError, type DelegationControlApi } from "./delegation-types.js";

export const DEFAULT_RESULT_FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_RESULT_FILE_CHUNK_BYTES = 1024 * 1024;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function within(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Only explicit file links in the latest final report are exportable. */
function linkedFiles(text: string, cwd: string): Set<string> {
  const files = new Set<string>();
  for (const match of text.matchAll(/\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\s)\r\n]+))\)/gu)) {
    const target = match[1] ?? match[2];
    if (!target) continue;
    try {
      let file: string;
      if (target.startsWith("file:")) {
        const url = new URL(target);
        if (url.username || url.password || url.search || url.hash) continue;
        file = fileURLToPath(url);
      } else {
        if (!path.isAbsolute(target) && /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
        file = decodeURIComponent(target);
      }
      const resolved = path.resolve(cwd, file);
      if (within(cwd, resolved)) files.add(resolved);
    } catch {
      // Remote URLs and malformed file links do not authorize a filesystem read.
    }
  }
  return files;
}

function integer(value: unknown, name: string, fallback: number, maximum?: number): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    (resolved as number) < 0 ||
    (maximum !== undefined && (resolved as number) > maximum)
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", `${name} is out of range`);
  }
  return resolved as number;
}

function revision(stat: Stats): string {
  return createHash("sha256")
    .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]))
    .digest("hex");
}

/** Reads on this Host, within the Thread's real workspace; no directory or arbitrary-path access. */
export async function readThreadResultFile(
  api: DelegationControlApi,
  input: Record<string, unknown>,
) {
  if (
    typeof input.threadId !== "string" ||
    !input.threadId.trim() ||
    typeof input.path !== "string" ||
    !input.path.trim()
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", "threadId and path are required");
  }
  const offset = integer(input.offset, "offset", 0);
  const limit = integer(
    input.limit,
    "limit",
    DEFAULT_RESULT_FILE_CHUNK_BYTES,
    MAX_RESULT_FILE_CHUNK_BYTES,
  );
  if (limit === 0) throw new DelegationControlError("INVALID_ARGUMENT", "limit must be positive");
  if (
    (input.revision !== undefined && typeof input.revision !== "string") ||
    (offset > 0 && !input.revision)
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Continuing a file requires its revision");
  }
  const snapshot = await api.read({ threadId: input.threadId, view: "result" });
  if (snapshot.hostId && snapshot.hostId !== "local") {
    throw new DelegationControlError(
      "UNSUPPORTED",
      "Read result files through their execution Host",
    );
  }
  if (
    !["completed", "failed", "interrupted"].includes(snapshot.status) ||
    snapshot.result.availability !== "available" ||
    !snapshot.result.text
  ) {
    throw new DelegationControlError("INVALID_ARGUMENT", "Thread has no final result to export");
  }
  if (!snapshot.cwd || !path.isAbsolute(snapshot.cwd)) {
    throw new DelegationControlError("UNSUPPORTED", "Thread workspace is unavailable");
  }
  const cwd = path.resolve(snapshot.cwd);
  const file = path.resolve(cwd, input.path);
  if (!linkedFiles(snapshot.result.text, cwd).has(file)) {
    throw new DelegationControlError(
      "FORBIDDEN",
      "File must be linked in the latest final result and inside its workspace",
    );
  }
  try {
    const [workspace, resolved] = await Promise.all([realpath(cwd), realpath(file)]);
    if (!within(workspace, resolved)) {
      throw new DelegationControlError(
        "FORBIDDEN",
        "Result file resolves outside the Thread workspace",
      );
    }
    if (!(await stat(resolved)).isFile()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Result must be a regular file");
    }
    const handle = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new DelegationControlError("INVALID_ARGUMENT", "Result must be a regular file");
      }
      const currentRevision = revision(before);
      if (input.revision !== undefined && input.revision !== currentRevision) {
        throw new DelegationControlError(
          "DELEGATION_FAILED",
          "Result file changed; restart the download",
        );
      }
      if (offset > before.size) {
        throw new DelegationControlError("INVALID_ARGUMENT", "offset exceeds the file size");
      }
      const buffer = Buffer.alloc(Math.min(limit, before.size - offset));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          offset + bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (revision(await handle.stat()) !== currentRevision || bytesRead !== buffer.length) {
        throw new DelegationControlError(
          "DELEGATION_FAILED",
          "Result file changed; restart the download",
        );
      }
      const nextOffset = offset + bytesRead;
      return {
        threadId: snapshot.threadId,
        path: path.relative(cwd, file),
        filename: path.basename(file),
        mimeType: MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        size: before.size,
        revision: currentRevision,
        offset,
        nextOffset,
        eof: nextOffset === before.size,
        encoding: "base64",
        data: buffer.toString("base64"),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof DelegationControlError) throw error;
    throw new DelegationControlError(
      "DELEGATION_FAILED",
      "Result file is unavailable or unreadable",
    );
  }
}
