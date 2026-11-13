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

/** Length of the line ending (LF, CR or CRLF) at `index`, or 0. */
function lineEnding(text: string, index: number): number {
  if (text[index] === "\n") return 1;
  if (text[index] === "\r") return text[index + 1] === "\n" ? 2 : 1;
  return 0;
}

/** Skips CommonMark link whitespace: spaces, tabs and at most one line ending. */
function linkSpace(text: string, index: number): number {
  let end = index;
  let crossed = false;
  for (;;) {
    if (text[end] === " " || text[end] === "\t") end += 1;
    else if (!crossed && lineEnding(text, end)) {
      end += lineEnding(text, end);
      crossed = true;
    } else return end;
  }
}

/** Index of the `)` closing a link after its destination, skipping an optional CommonMark title. */
function closingParenthesis(text: string, index: number): number | undefined {
  // A second line ending here is a blank line, which ends the paragraph and the link.
  let end = linkSpace(text, index);
  if (text[end] === ")") return end;
  if (end === index) return undefined;
  const open = text[end];
  const close = open === '"' ? '"' : open === "'" ? "'" : open === "(" ? ")" : undefined;
  if (!close) return undefined;
  for (end += 1; end < text.length && text[end] !== close; end += 1) {
    // A backslash before a line ending is literal, so the blank-line check still sees it.
    if (text[end] === "\\" && !lineEnding(text, end + 1)) end += 1;
    else if (open === "(" && text[end] === "(") return undefined;
    else if (lineEnding(text, end)) {
      // A title may span lines but not a blank line.
      const next = linkSpace(text, end);
      if (lineEnding(text, next)) return undefined;
      end = next - 1;
    }
  }
  if (end >= text.length) return undefined;
  end = linkSpace(text, end + 1);
  return text[end] === ")" ? end : undefined;
}

/** Local path spellings of one link: percent-decoded or literal, with and without a `#fragment`. */
function pathCandidates(target: string): string[] {
  const spellings = new Set<string>();
  // The literal spelling may name a file containing `#`; otherwise the fragment starts at the first `#`.
  const fragment = target.indexOf("#");
  for (const value of [target, fragment < 0 ? target : target.slice(0, fragment)]) {
    if (!value) continue;
    spellings.add(value);
    try {
      spellings.add(decodeURIComponent(value));
    } catch {
      // A literal `%` in a file name is not an escape.
    }
  }
  return [...spellings];
}

/** Only explicit file links in the latest final report are exportable. */
function linkedFiles(text: string, cwd: string): Set<string> {
  const files = new Set<string>();
  const links = /\[[^\]\r\n]*\]\(/gu;
  for (let match = links.exec(text); match; match = links.exec(text)) {
    const start = links.lastIndex;
    let end = start;
    let target: string;
    if (text[start] === "<") {
      end = text.indexOf(">", start + 1);
      if (end < 0) continue;
      const close = closingParenthesis(text, end + 1);
      if (close === undefined) continue;
      target = text.slice(start + 1, end);
      if (/[\r\n]/u.test(target)) continue;
      links.lastIndex = close + 1;
    } else {
      let depth = 0;
      while (end < text.length && !/\s/u.test(text[end] as string)) {
        const character = text[end];
        if (character === "\\" && /[\\()]/u.test(text[end + 1] ?? "")) {
          end += 2;
          continue;
        }
        if (character === "(") depth += 1;
        else if (character === ")") {
          if (depth === 0) break;
          depth -= 1;
        }
        end += 1;
      }
      const close = depth === 0 ? closingParenthesis(text, end) : undefined;
      links.lastIndex = (close ?? end) + 1;
      if (close === undefined) continue;
      target = text.slice(start, end).replace(/\\([\\()])/gu, "$1");
    }
    if (!target) continue;
    try {
      let candidates: string[];
      if (target.startsWith("file:")) {
        const url = new URL(target);
        if (url.username || url.password || url.search || url.hash) continue;
        candidates = [fileURLToPath(url)];
      } else {
        if (!path.isAbsolute(target) && /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
        candidates = pathCandidates(target);
      }
      for (const file of candidates) {
        const resolved = path.resolve(cwd, file);
        if (within(cwd, resolved)) files.add(resolved);
      }
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
    const [workspaceInfo, authorized] = await Promise.all([
      stat(workspace, { bigint: true }),
      stat(resolved, { bigint: true }),
    ]);
    if (!authorized.isFile()) {
      throw new DelegationControlError("INVALID_ARGUMENT", "Result must be a regular file");
    }
    const checkPaths = async () => {
      const [currentWorkspace, currentFile, currentWorkspaceInfo] = await Promise.all([
        realpath(cwd),
        realpath(file),
        stat(workspace, { bigint: true }),
      ]);
      if (
        currentWorkspace !== workspace ||
        currentFile !== resolved ||
        currentWorkspaceInfo.dev !== workspaceInfo.dev ||
        currentWorkspaceInfo.ino !== workspaceInfo.ino
      ) {
        throw new DelegationControlError("FORBIDDEN", "Result file path changed during the read");
      }
    };
    await checkPaths();
    const handle = await open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      // O_NOFOLLOW covers only the last component. Pin the authorized object before
      // reading; path rechecks detect persistent directory swaps, not arbitrary ABA races.
      const opened = await handle.stat({ bigint: true });
      if (opened.dev !== authorized.dev || opened.ino !== authorized.ino) {
        throw new DelegationControlError("FORBIDDEN", "Result file changed before it was opened");
      }
      await checkPaths();
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
      await checkPaths();
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
