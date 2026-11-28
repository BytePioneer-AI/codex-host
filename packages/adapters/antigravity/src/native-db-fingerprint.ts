import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readHeadHex(
  filePath: string,
  offset: number,
  length: number,
): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("hex");
  } catch (error) {
    if (isMissing(error)) return "missing";
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Lightweight async fingerprint for append-mostly files such as `transcript.jsonl`.
 * Returns `"missing"` when absent, or `null` when stat fails unexpectedly (caller must not skip).
 */
export async function readFileFingerprint(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if (isMissing(error)) return "missing";
    return null;
  }
}

async function readSqlitePart(
  filePath: string,
  headerOffset: number,
  headerLength: number,
): Promise<string | null> {
  let info: BigIntStats;
  try {
    info = await stat(filePath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return "missing";
    return null;
  }
  const head =
    info.size > BigInt(headerOffset) ? await readHeadHex(filePath, headerOffset, headerLength) : "";
  if (head === null) return null;
  return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${head}`;
}

/**
 * Async change fingerprint for a SQLite database covering DELETE and WAL modes without opening
 * `DatabaseSync`:
 * - `.db` stat + 4-byte file change counter (offset 24..27), which increments on every non-WAL
 *   commit even for same-millisecond in-page writes that keep file size unchanged.
 * - `-wal` stat + 32-byte WAL header (checkpoint sequence & salts).
 * - `-shm` first 48 bytes (WAL-index header `mxFrame` & checksums), which update on every WAL
 *   commit even when rewriting frames inside a pre-allocated `-wal` file.
 *
 * Returns `null` on unexpected I/O error so callers fall back to reading normally.
 */
export async function readNativeDbFingerprint(dbPath: string): Promise<string | null> {
  const [dbPart, walPart, shmHead] = await Promise.all([
    readSqlitePart(dbPath, 24, 4),
    readSqlitePart(`${dbPath}-wal`, 0, 32),
    readHeadHex(`${dbPath}-shm`, 0, 48),
  ]);
  if (dbPart === null || walPart === null || shmHead === null) return null;
  return `${dbPart}|${walPart}|${shmHead}`;
}
