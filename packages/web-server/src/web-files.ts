/** Web-owned opaque file bytes and disposable, Session-scoped upload receipts. */
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, realpath, lstat, link, rm } from "node:fs/promises";
import { mkdirSync, realpathSync, lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DataDir } from "./store.ts";
import { RpcError } from "./transport.ts";

export const WEB_FILE_INPUT = { enabled: true };
export interface WebFileRef {
  attachmentId: string;
  name: string;
  bytes: number;
}
export interface SavedFile {
  path: string;
  file: WebFileRef;
}
interface Receipt extends SavedFile {
  sessionId: string;
  hash: string;
  expiresAt: number;
}
function invalid(reason: string, message: string): never {
  throw new RpcError("session/attachment-invalid", message, { reason });
}
function safeName(name = "attachment"): string {
  const clean = name
    .normalize("NFC")
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/gu, "_")
    .trim()
    .replace(/[. ]+$/gu, "");
  let result = "";
  for (const char of clean) {
    if (Buffer.byteLength(result + char) > 160) break;
    result += char;
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) result = "_" + result;
  return result || "attachment";
}

export class WebFiles {
  readonly directory: string;
  private readonly receipts = new Map<string, Receipt>();
  constructor(data: DataDir) {
    const path = data.path("attachments", "files");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Web file directory must not be a symlink");
    // Match fs/promises.realpath's native Windows representation (drive case,
    // junction resolution and expanded 8.3 names), not the JS fallback spelling.
    this.directory = realpathSync.native(path);
    if (/[\u0000-\u001f\u007f]/u.test(this.directory))
      throw new Error("Invalid Web file directory");
  }
  private prune(): void {
    for (const [id, receipt] of this.receipts)
      if (receipt.expiresAt <= Date.now()) this.receipts.delete(id);
  }
  async upload(sessionId: string, chunks: AsyncIterable<Uint8Array>, name?: string) {
    this.prune();
    // UUID directories isolate incomplete streams; only completed objects receive a receipt.
    const pending = join(this.directory, randomUUID());
    await mkdir(pending, { mode: 0o700 });
    const temporary = join(pending, "pending");
    const fd = await open(temporary, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (!Number.isSafeInteger(bytes)) throw new Error("File size cannot be represented safely");
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const written = await fd.write(chunk, offset, chunk.byteLength - offset);
          if (!written.bytesWritten) throw new Error("File write made no progress");
          offset += written.bytesWritten;
        }
      }
      await fd.close();
      const hash = digest.digest("hex");
      const folder = join(this.directory, hash);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      if ((await lstat(folder)).isSymbolicLink() || (await realpath(folder)) !== folder)
        throw new Error("File directory symlink refused");
      const filename = safeName(name);
      const path = join(folder, filename);
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verify(path, hash, bytes);
      }
      const file = this.reference(path);
      if (!file) throw new Error("Stored file unavailable");
      const receiptId = randomUUID();
      this.receipts.set(receiptId, {
        sessionId,
        hash,
        path,
        file,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      return { receiptId, file };
    } finally {
      await fd.close().catch(() => {});
      await rm(pending, { recursive: true, force: true });
    }
  }
  bind(from: string, to: string): void {
    for (const receipt of this.receipts.values())
      if (receipt.sessionId === from) receipt.sessionId = to;
  }
  async resolve(sessionId: string, ids: readonly string[]): Promise<SavedFile[]> {
    this.prune();
    const files: SavedFile[] = [];
    for (const id of ids) {
      const receipt = this.receipts.get(id);
      if (!receipt || receipt.sessionId !== sessionId)
        invalid("FILE_NOT_STAGED", "File was not uploaded for this session; select it again.");
      await this.verify(receipt.path, receipt.hash, receipt.file.bytes);
      files.push(receipt);
    }
    return files;
  }
  consume(sessionId: string, ids: readonly string[]): void {
    for (const id of ids)
      if (this.receipts.get(id)?.sessionId === sessionId) this.receipts.delete(id);
  }
  /** Only Web-owned paths receive byte metadata; ordinary native files remain references. */
  reference(path: string): WebFileRef | undefined {
    const folder = dirname(resolve(path));
    const name = basename(path);
    if (
      dirname(folder) !== this.directory ||
      !/^[a-f0-9]{64}$/u.test(basename(folder)) ||
      safeName(name) !== name
    )
      return undefined;
    try {
      if (realpathSync.native(path) !== join(folder, name) || lstatSync(path).isSymbolicLink())
        return undefined;
      const stat = lstatSync(path);
      if (!stat.isFile() || !Number.isSafeInteger(stat.size)) return undefined;
      return {
        attachmentId: `web-file:${basename(folder)}/${encodeURIComponent(name)}`,
        name,
        bytes: stat.size,
      };
    } catch {
      return undefined;
    }
  }
  private async verify(path: string, hash: string, bytes: number): Promise<void> {
    let fd;
    try {
      if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
        throw new Error("File symlink refused");
      fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await fd.stat();
      if (!before.isFile() || before.size !== bytes || !Number.isSafeInteger(bytes))
        throw new Error("File size changed");
      const digest = createHash("sha256");
      let length = 0;
      for await (const chunk of createReadStream(path, { fd: fd.fd, autoClose: false })) {
        length += (chunk as Buffer).length;
        if (length > bytes) throw new Error("File grew while reading");
        digest.update(chunk as Buffer);
      }
      const after = await fd.stat();
      if (
        length !== bytes ||
        digest.digest("hex") !== hash ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error("File content changed");
    } catch {
      invalid("FILE_UNAVAILABLE", "The uploaded file is unavailable or changed; select it again.");
    } finally {
      await fd?.close();
    }
  }
}
