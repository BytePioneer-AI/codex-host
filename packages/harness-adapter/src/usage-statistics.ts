import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import type { HostUsageRequest } from "./usage.js";

/**
 * Optional Adapter capability for the machine-wide usage statistics: read-only access to the
 * Harness's own local session storage. It never starts a native process, opens a Session, or
 * writes native storage; the Host only aggregates what it returns.
 */
export interface HarnessUsageStatisticsCapability {
  /** Current native ID → display label metadata, read locally without starting a process.
   * Labels are not historical model identity or pricing aliases. Failure must not lose usage.
   */
  readModelLabels?(signal: AbortSignal): Promise<Readonly<Record<string, string>>>;
  /** Every unit of native storage that may hold usage, with a fingerprint read without content. */
  listSources(signal: AbortSignal): Promise<readonly HarnessUsageSource[]>;
  /** The usage entries in one unit. A copied history (a fork) may repeat entry IDs.
   * Throw HarnessUsageSourceChangedError if the listed fingerprint no longer describes the read.
   */
  readSource(id: string, signal: AbortSignal): Promise<readonly HarnessUsageEntry[]>;
}

/** A read whose source changed; callers must list sources again before retrying it. */
export class HarnessUsageSourceChangedError extends Error {
  readonly code = "HARNESS_USAGE_SOURCE_CHANGED";

  /** Plugins may bundle their own copy of this contract, so instanceof is insufficient. */
  static is(error: unknown): error is HarnessUsageSourceChangedError {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "HARNESS_USAGE_SOURCE_CHANGED"
    );
  }
}

export interface HarnessUsageSource {
  /** Stable for the unit, such as its absolute file path. */
  id: string;
  /** Changes whenever the unit's content may have changed. */
  fingerprint: string;
}

/**
 * One native model request in the unified convention of {@link HostUsageRequest}: input includes
 * cache reads and writes, output includes reasoning, and an absent cache field is unknown.
 */
export interface HarnessUsageEntry {
  /** Unique within the Harness; a copy of the same request in a fork keeps the same ID. */
  id: string;
  /** When the native record says the request happened, epoch milliseconds. */
  occurredAtMs: number;
  /** Native model ID actually used. */
  model?: string;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  /** Native session (thread) the request belongs to, when the storage names it. */
  sessionId?: string;
  /** Display name of that session, when the storage names it. */
  sessionTitle?: string;
  /** Absolute working directory of that session, when the storage names it. */
  cwd?: string;
  /**
   * What the Harness itself recorded the request cost, in USD, when its storage has it. The Host
   * uses it instead of a list price, unless the user set a price for the model.
   */
  costUsd?: number;
  /**
   * The storage records the request but no token counts for it (every bucket zero). It counts as
   * a request; its tokens and cost are unknown rather than zero.
   */
  tokensUnknown?: true;
  /** Native credits consumed by this request; zero is known, absent is unknown.
   * Harness-specific units, never converted to USD or summed across Harnesses.
   */
  credits?: number;
}

/** Where a session's requests ran, as an Adapter read it from native storage. */
export interface HarnessUsageSession {
  sessionId?: string | null | undefined;
  cwd?: string | null | undefined;
  /** Native display name: user-given, agent-generated, or first typed prompt. */
  title?: string | null | undefined;
}

const MAX_SESSION_ID_LENGTH = 512;
const MAX_CWD_LENGTH = 4096;
/** Match the statistics schema's UTF-16 limit without splitting a code point. */
const MAX_SESSION_TITLE_LENGTH = 200;

/** Single-line session name, or undefined when the storage has none the Host can show. */
export function usageSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\0", "").replaceAll(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_SESSION_TITLE_LENGTH) return normalized;
  let title = "";
  for (const character of normalized) {
    if (title.length + character.length >= MAX_SESSION_TITLE_LENGTH) break;
    title += character;
  }
  return `${title.trimEnd()}…`;
}

function sessionIdOk(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

function cwdOk(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CWD_LENGTH &&
    !value.includes("\u0000") &&
    (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"))
  );
}

/**
 * The entry attributed to its session. Values the Host would reject (empty, oversized, or a
 * relative directory) are left out rather than failing the entry: usage counts without them.
 */
export function withUsageSession(
  entry: HarnessUsageEntry,
  session: HarnessUsageSession,
): HarnessUsageEntry {
  const sessionId = sessionIdOk(session.sessionId) ? session.sessionId : undefined;
  const cwd = cwdOk(session.cwd) ? session.cwd : undefined;
  const sessionTitle = sessionId !== undefined ? usageSessionTitle(session.title) : undefined;
  if (sessionId === undefined && cwd === undefined) return entry;
  return {
    ...entry,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sessionTitle !== undefined ? { sessionTitle } : {}),
  };
}

/** An entry from a request the Adapter already parsed, or null without a native time. */
export function usageEntryFromRequest(
  request: HostUsageRequest,
  occurredAtMs: number,
): HarnessUsageEntry | null {
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs <= 0) return null;
  return {
    id: request.requestId,
    occurredAtMs,
    ...(request.model !== undefined ? { model: request.model } : {}),
    inputTokens: request.inputTokens,
    ...(request.cachedInputTokens !== undefined
      ? { cachedInputTokens: request.cachedInputTokens }
      : {}),
    ...(request.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: request.cacheWriteInputTokens }
      : {}),
    ...(request.cacheWrite1hInputTokens !== undefined
      ? { cacheWrite1hInputTokens: request.cacheWrite1hInputTokens }
      : {}),
    outputTokens: request.outputTokens,
    ...(request.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: request.reasoningOutputTokens }
      : {}),
  };
}

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates an entry from an Adapter; returns null for anything the Host must not count. */
export function parseHarnessUsageEntry(value: unknown): HarnessUsageEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 512) return null;
  if (!tokenCount(entry.occurredAtMs) || entry.occurredAtMs === 0) return null;
  if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.length === 0)) {
    return null;
  }
  if (!tokenCount(entry.inputTokens) || !tokenCount(entry.outputTokens)) return null;
  for (const field of [
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "cacheWrite1hInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (entry[field] !== undefined && !tokenCount(entry[field])) return null;
  }
  const cached = (entry.cachedInputTokens as number | undefined) ?? 0;
  const written = (entry.cacheWriteInputTokens as number | undefined) ?? 0;
  if (cached + written > entry.inputTokens) return null;
  if (((entry.cacheWrite1hInputTokens as number | undefined) ?? 0) > written) return null;
  if (((entry.reasoningOutputTokens as number | undefined) ?? 0) > entry.outputTokens) return null;
  if (entry.sessionId !== undefined && !sessionIdOk(entry.sessionId)) return null;
  if (entry.cwd !== undefined && !cwdOk(entry.cwd)) return null;
  if (entry.sessionTitle !== undefined) {
    const sessionTitle = usageSessionTitle(entry.sessionTitle);
    if (sessionTitle === undefined) return null;
    entry.sessionTitle = sessionTitle;
  }
  if (entry.tokensUnknown !== undefined && entry.tokensUnknown !== true) return null;
  if (
    entry.costUsd !== undefined &&
    (typeof entry.costUsd !== "number" || !Number.isFinite(entry.costUsd) || entry.costUsd < 0)
  ) {
    return null;
  }
  if (
    entry.credits !== undefined &&
    (typeof entry.credits !== "number" || !Number.isFinite(entry.credits) || entry.credits < 0)
  ) {
    return null;
  }
  return entry as unknown as HarnessUsageEntry;
}

const JSONL_CHUNK_BYTES = 128 * 1024;
const JSONL_HEADER_CHUNK_BYTES = 16 * 1024;

/**
 * `.jsonl` files under `root`, at most `maxDepth` directories down. Links are never followed and
 * a missing root is empty. The fingerprint is identity, size and modification time.
 */
export async function jsonlUsageSources(
  root: string,
  maxDepth: number,
  signal: AbortSignal,
): Promise<HarnessUsageSource[]> {
  const sources: HarnessUsageSource[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!entries) return;
    const subdirectories: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) subdirectories.push(file);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(file);
      }
    }
    if (files.length > 0) {
      const stats = await Promise.all(files.map((file) => lstat(file).catch(() => null)));
      signal.throwIfAborted();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const info = stats[i];
        if (file && info?.isFile() && info.size > 0) {
          sources.push({
            id: file,
            fingerprint: `${info.ino}:${info.size}:${info.mtimeMs}`,
          });
        }
      }
    }
    for (const subdirectory of subdirectories) await visit(subdirectory, depth + 1);
  };
  await visit(root, 0);
  return sources;
}

function concatParts(parts: readonly Buffer[], total: number): Buffer {
  const [single] = parts;
  return single && parts.length === 1 ? single : Buffer.concat(parts, total);
}

async function* jsonlLineSlices(
  file: string,
  signal: AbortSignal,
  highWaterMark: number,
): AsyncGenerator<Buffer> {
  const stream = createReadStream(file, { highWaterMark, signal });
  let parts: Buffer[] = [];
  let buffered = 0;
  try {
    for await (const raw of stream) {
      signal.throwIfAborted();
      const chunk = raw as Buffer;
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf(0x0a, start)) >= 0) {
        const lineEnd = end > start && chunk[end - 1] === 0x0d ? end - 1 : end;
        const slice = chunk.subarray(start, lineEnd);
        if (buffered === 0) {
          yield slice;
        } else {
          if (slice.length > 0) {
            parts.push(slice);
            buffered += slice.length;
          }
          const combined = concatParts(parts, buffered);
          parts = [];
          buffered = 0;
          yield combined.length > 0 && combined[combined.length - 1] === 0x0d
            ? combined.subarray(0, combined.length - 1)
            : combined;
        }
        start = end + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        parts.push(rest);
        buffered += rest.length;
      }
    }
    if (buffered > 0) {
      const combined = concatParts(parts, buffered);
      yield combined.length > 0 && combined[combined.length - 1] === 0x0d
        ? combined.subarray(0, combined.length - 1)
        : combined;
    }
  } finally {
    stream.destroy();
  }
}

/**
 * The JSON objects of the lines of a `.jsonl` file that contain `marker`. Other lines (tool
 * output, conversation text) are skipped in Buffer form before UTF-8 decoding; malformed lines
 * are skipped.
 */
export async function* jsonlRecords(
  file: string,
  marker: string,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const markerBytes = marker.length > 0 ? Buffer.from(marker, "utf8") : null;
  for await (const rawLine of jsonlLineSlices(file, signal, JSONL_CHUNK_BYTES)) {
    if (markerBytes && !rawLine.includes(markerBytes)) continue;
    const line = rawLine.toString("utf8");
    if (!line.includes(marker)) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      yield value as Record<string, unknown>;
    }
  }
}

/**
 * The first record among the opening `maxLines` lines of a `.jsonl` file that `match` accepts,
 * such as a session header; reading stops there, so a large file is not read through.
 */
export async function jsonlHeader(
  file: string,
  match: (record: Record<string, unknown>) => boolean,
  signal: AbortSignal,
  maxLines = 4,
): Promise<Record<string, unknown> | null> {
  let seen = 0;
  for await (const rawLine of jsonlLineSlices(file, signal, JSONL_HEADER_CHUNK_BYTES)) {
    if (++seen > maxLines) break;
    let value: unknown;
    try {
      value = JSON.parse(rawLine.toString("utf8"));
    } catch {
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (match(record)) return record;
    }
  }
  return null;
}

/** Epoch milliseconds from a native number or date string, or null. */
export function nativeTimeMs(value: unknown): number | null {
  const time =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) && time > 0 ? Math.floor(time) : null;
}
