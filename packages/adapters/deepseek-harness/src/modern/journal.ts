import {
  ModernJournalError,
  type ModernJournalErrorCode,
  assertJsonValue,
  hasExactKeys,
  isRecord,
  isCursor,
  protocolError,
  limitError,
} from "../profiles/journal-format.js";
/** Strict, single-generation DeepSeek Harness Modern Session journal reader. */

import { ModernRemoteConnectionError } from "./remote-connection.js";
import { DEEPSEEK_V012_PROFILE, type DeepSeekModernProfile } from "../profiles/profile.js";
import {
  DeepSeekV015ProtocolError,
  expandV015AssistantStream,
  type DeepSeekV015AssistantBaseline,
  type DeepSeekV015AssistantFrame,
} from "../profiles/v015.js";
import { sanitizeModernRemoteFailure, type ModernRemoteResult } from "./wire.js";

export const MODERN_JOURNAL_PAGE_MAX_MESSAGES = 200;
export const MODERN_JOURNAL_MAX_RECORDS_PER_PAGE = 100_000;
export const MODERN_JOURNAL_MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const MODERN_JOURNAL_MAX_PAGE_REQUESTS = 10_000;
export const MODERN_JOURNAL_MAX_EVENTS = 1_000_000;
export const MODERN_JOURNAL_MAX_HISTORY_BYTES = 128 * 1024 * 1024;
export const MODERN_JOURNAL_MAX_BUFFERED_LIVE_EVENTS = 8_192;
export const MODERN_JOURNAL_MAX_BUFFERED_LIVE_BYTES = 32 * 1024 * 1024;
export const MODERN_JOURNAL_RECOVERY_OPEN_TIMEOUT_MS = 10_000;

export type ModernJournalJson =
  | null
  | boolean
  | number
  | string
  | readonly ModernJournalJson[]
  | { readonly [key: string]: ModernJournalJson };

export interface ModernJournalHeader {
  readonly version: 0 | 3;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly isSeeded?: boolean;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export interface ModernJournalAssistantStream {
  readonly type: "assistant-stream";
  readonly frame: DeepSeekV015AssistantFrame;
}

export type ModernJournalLiveItem = ModernJournalEvent | ModernJournalAssistantStream;

export type ModernJournalSurfaceOp =
  | "append"
  | { readonly op: "replace"; readonly start: number; readonly end: number }
  | { readonly op: "replace"; readonly startSeq: number; readonly endSeq: number };

/** Generic event envelope; unknown event names remain available to the projector. */
export interface ModernJournalEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: ModernJournalJson;
  readonly ignorable?: true;
  /** V3 unknown ignorable events retain opaque JSON metadata without surface meaning. */
  readonly sourceEventSeqs?: ModernJournalJson;
  readonly surfaceOp?: ModernJournalJson;
}

export interface ModernJournalProjections {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, ModernJournalJson>>;
}

export interface ModernJournal {
  readonly profile?: DeepSeekModernProfile;
  readonly header: ModernJournalHeader;
  readonly inheritedEventCount?: number;
  readonly cursor: number;
  readonly projections: ModernJournalProjections;
  readonly events: readonly ModernJournalEvent[];
  readonly live: AsyncIterable<ModernJournalLiveItem>;
  close(): Promise<void>;
}

export interface ModernJournalRemote {
  call<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ModernRemoteResult<T>>;
  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T>;
}

export interface ModernJournalOpenRequest {
  readonly sessionId: string;
  /** Exact cwd expected from the durable Session header; undefined requires field absence. */
  readonly cwd?: string;
}

export interface ModernJournalOptions {
  readonly profile?: DeepSeekModernProfile;
  readonly pageMaxMessages?: number;
  readonly maxRecordsPerPage?: number;
  readonly maxRecordBytes?: number;
  readonly maxPageRequests?: number;
  readonly maxEvents?: number;
  readonly maxHistoryBytes?: number;
  readonly maxBufferedLiveEvents?: number;
  readonly maxBufferedLiveBytes?: number;
  readonly openingTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export { ModernJournalError, type ModernJournalErrorCode } from "../profiles/journal-format.js";
/** A transient Assistant presentation gap that a fresh opening baseline can repair. */
export class ModernJournalDesyncError extends ModernJournalError {
  constructor(message: string) {
    super("protocolError", message);
    this.name = "ModernJournalDesyncError";
  }
}

interface ResolvedOptions {
  readonly pageMaxMessages: number;
  readonly maxRecordsPerPage: number;
  readonly maxRecordBytes: number;
  readonly maxPageRequests: number;
  readonly maxEvents: number;
  readonly maxHistoryBytes: number;
  readonly maxBufferedLiveEvents: number;
  readonly maxBufferedLiveBytes: number;
}

interface ParsedWindow {
  readonly events: ModernJournalEvent[];
  readonly hasMore: boolean;
  readonly retainedBytes: number;
}

/** Open one immutable history cut plus its already-running live successor. */
export async function openModernJournal(
  remote: ModernJournalRemote,
  request: ModernJournalOpenRequest,
  options: ModernJournalOptions = {},
): Promise<ModernJournal> {
  if (typeof request.sessionId !== "string" || request.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  if (request.cwd !== undefined && typeof request.cwd !== "string") {
    throw new TypeError("cwd must be a string when present");
  }
  const limits = resolveOptions(options);
  const profile = options.profile ?? DEEPSEEK_V012_PROFILE;
  const address = { kind: "session" as const, sessionId: request.sessionId };
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const openingTimeout = AbortSignal.timeout(
    options.openingTimeoutMs ?? MODERN_JOURNAL_RECOVERY_OPEN_TIMEOUT_MS,
  );
  const openingSignal = AbortSignal.any([signal, openingTimeout]);
  let iterator: AsyncIterator<unknown>;
  try {
    iterator = remote
      .openStream<unknown>(
        "session/follow",
        {
          request: {
            address,
            maxMessages: limits.pageMaxMessages,
            ...(profile.assistantStream ? { assistantStream: true } : {}),
          },
        },
        signal,
      )
      [Symbol.asyncIterator]();
  } catch (error) {
    throw normalizeError(error, "DeepSeek Harness journal follow could not open");
  }

  const returnFollow = onceAsync(async () => {
    await iterator.return?.();
  });
  let opening: ReturnType<typeof parseOpeningSnapshot>;
  try {
    const first = await nextBeforeAbort(iterator, openingSignal);
    if (first.done) throw protocolError("journal follow ended before its opening snapshot");
    opening = parseOpeningSnapshot(first.value, request, limits, profile);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([returnFollow()]);
    throw normalizeError(error, "DeepSeek Harness journal opening snapshot failed");
  }

  let retainedHistoryBytes = opening.retainedBytes;
  const reserveHistoryBytes = (bytes: number): void => {
    if (bytes > limits.maxHistoryBytes - retainedHistoryBytes) {
      throw limitError("journal history exceeded maxHistoryBytes");
    }
    retainedHistoryBytes += bytes;
  };
  const liveBuffer = new LiveBuffer(limits.maxBufferedLiveEvents, limits.maxBufferedLiveBytes);
  try {
    if (opening.assistantStream?.activeAttempt) {
      const attempt = opening.assistantStream.activeAttempt;
      const openingFrames: DeepSeekV015AssistantFrame[] = [
        {
          type: "start",
          attemptId: attempt.attemptId,
          revision: opening.assistantStream.revision,
          startedAfterSeq: attempt.startedAfterSeq,
          turn: attempt.turn,
          step: attempt.step,
        },
        ...expandV015AssistantStream(attempt.stream).map(
          ({ time, chunk }, index): DeepSeekV015AssistantFrame => ({
            type: "chunk",
            attemptId: attempt.attemptId,
            revision: opening.assistantStream?.revision as number,
            index,
            time,
            chunk,
          }),
        ),
      ];
      for (const frame of openingFrames) {
        const item = { type: "assistant-stream" as const, frame };
        liveBuffer.push(item, assertWireBytes(item, limits.maxRecordBytes, "assistant baseline"));
      }
    }
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled([returnFollow()]);
    throw normalizeError(error, "DeepSeek Harness assistant baseline failed");
  }
  let closing = false;
  let pumpFailure: ModernJournalError | undefined;
  let expectedLiveSeq = opening.cursor + 1;
  let assistantRevision = opening.assistantStream?.revision;
  const pump = (async (): Promise<void> => {
    try {
      while (!closing) {
        const item = await iterator.next();
        if (item.done) {
          if (closing) break;
          throw new ModernJournalError("unavailable", "journal follow ended unexpectedly");
        }
        const parsed = parseLiveItem(item.value, limits, profile);
        if ("frame" in parsed.item) {
          const expectedRevision = (assistantRevision ?? 0) + 1;
          const restartsLifecycle =
            parsed.item.frame.type === "start" && parsed.item.frame.revision === 1;
          if (!restartsLifecycle && parsed.item.frame.revision !== expectedRevision) {
            throw new ModernJournalDesyncError(
              "journal assistant stream is not revision-contiguous",
            );
          }
          assistantRevision = parsed.item.frame.revision;
        } else {
          if (parsed.item.seq !== expectedLiveSeq) {
            throw protocolError("journal live events are not sequence-contiguous");
          }
          expectedLiveSeq += 1;
          reserveHistoryBytes(parsed.retainedBytes);
        }
        liveBuffer.push(parsed.item, parsed.retainedBytes);
      }
      liveBuffer.end();
    } catch (error) {
      if (closing) {
        liveBuffer.end();
        return;
      }
      pumpFailure = normalizeError(error, "DeepSeek Harness journal live follow failed");
      liveBuffer.fail(pumpFailure);
      controller.abort(pumpFailure);
      await Promise.allSettled([returnFollow()]);
    }
  })();

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      controller.abort(new Error("DeepSeek Harness journal closed"));
      liveBuffer.end();
      const [returned, pumped] = await Promise.allSettled([returnFollow(), pump]);
      if (returned.status === "rejected") {
        throw normalizeError(returned.reason, "DeepSeek Harness journal follow close failed");
      }
      if (pumped.status === "rejected") {
        throw normalizeError(pumped.reason, "DeepSeek Harness journal live pump close failed");
      }
    })();
    return closePromise;
  };

  try {
    const segments: ModernJournalEvent[][] = [opening.events];
    let totalEvents = opening.events.length;
    let oldestSeq = opening.events[0]?.seq ?? opening.cursor + 1;
    let hasMore = opening.hasMore;
    let pageRequests = 0;
    while (hasMore) {
      if (pageRequests >= limits.maxPageRequests) {
        throw limitError("journal pagination exceeded maxPageRequests");
      }
      pageRequests += 1;
      const result = await remote.call<unknown>(
        "session/page",
        {
          request: {
            address,
            throughSeq: opening.cursor,
            beforeSeq: oldestSeq,
            maxMessages: limits.pageMaxMessages,
          },
        },
        signal,
      );
      if (pumpFailure) throw pumpFailure;
      if (!result.ok) throw remoteResultError("session/page", result.error);
      const page = parsePage(result.value, oldestSeq - 1, limits, profile);
      const firstSeq = page.events[0]?.seq;
      if (firstSeq === undefined || firstSeq >= oldestSeq) {
        throw protocolError("journal page made no backwards progress");
      }
      segments.push(page.events);
      totalEvents += page.events.length;
      if (totalEvents > limits.maxEvents) throw limitError("journal history exceeded maxEvents");
      reserveHistoryBytes(page.retainedBytes);
      oldestSeq = firstSeq;
      hasMore = page.hasMore;
    }
    if (pumpFailure) throw pumpFailure;
    const events = segments.reverse().flat();
    if (events.length !== opening.cursor + 1 || (opening.cursor >= 0 && events[0]?.seq !== 0)) {
      throw protocolError("journal history is not a complete zero-based event prefix");
    }
    assertContiguous(events, "journal history");

    const inheritedEventCount = profile.inheritedEventCount(opening.header, events);
    let liveClaimed = false;
    const live: AsyncIterable<ModernJournalLiveItem> = {
      [Symbol.asyncIterator](): AsyncIterator<ModernJournalLiveItem> {
        if (liveClaimed)
          throw new ModernJournalError("protocolError", "journal live stream is single-use");
        liveClaimed = true;
        const source = liveBuffer[Symbol.asyncIterator]();
        return {
          next: () => source.next(),
          return: async () => {
            await close();
            return { done: true, value: undefined };
          },
        };
      },
    };
    return {
      profile,
      header: opening.header,
      ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
      cursor: opening.cursor,
      projections: opening.projections,
      events,
      live,
      close,
    };
  } catch (error) {
    const failure = pumpFailure ?? normalizeError(error, "DeepSeek Harness journal history failed");
    await Promise.allSettled([close()]);
    throw failure;
  }
}

function parseOpeningSnapshot(
  value: unknown,
  request: ModernJournalOpenRequest,
  limits: ResolvedOptions,
  profile: DeepSeekModernProfile,
): {
  readonly header: ModernJournalHeader;
  readonly cursor: number;
  readonly events: ModernJournalEvent[];
  readonly hasMore: boolean;
  readonly projections: ModernJournalProjections;
  readonly retainedBytes: number;
  readonly assistantStream?: DeepSeekV015AssistantBaseline;
} {
  const expectedKeys = profile.snapshotKeys;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, expectedKeys) ||
    value.type !== "snapshot" ||
    !isCursor(value.cursor) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw protocolError("journal follow emitted an invalid opening snapshot");
  }
  if (value.cursor + 1 > limits.maxEvents) {
    throw limitError("journal opening cursor exceeded maxEvents");
  }
  assertWireBytes(value.header, limits.maxRecordBytes, "journal header");
  const header = profile.parseHeader(value.header, request);
  if (header.seedLength !== undefined && header.seedLength > value.cursor + 1) {
    throw protocolError("journal snapshot seedLength is past its opening cursor");
  }
  const projections = parseProjections(value.projections, value.cursor, limits.maxRecordBytes);
  const window = parseWindow(
    value.records,
    value.hasMore,
    value.cursor,
    "journal snapshot",
    limits,
    profile,
  );
  let assistantStream: DeepSeekV015AssistantBaseline | undefined;
  if (profile.parseAssistantBaseline) {
    assertWireBytes(value.assistantStream, limits.maxRecordBytes, "assistant stream baseline");
    assistantStream = profile.parseAssistantBaseline(value.assistantStream);
    if (
      assistantStream.activeAttempt &&
      assistantStream.activeAttempt.startedAfterSeq > value.cursor
    )
      throw protocolError("assistant stream baseline starts after the durable cursor");
  }
  return {
    header,
    cursor: value.cursor,
    events: window.events,
    hasMore: window.hasMore,
    projections,
    retainedBytes: window.retainedBytes,
    ...(assistantStream === undefined ? {} : { assistantStream }),
  };
}

function parsePage(
  value: unknown,
  expectedLastSeq: number,
  limits: ResolvedOptions,
  profile: DeepSeekModernProfile,
): ParsedWindow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["records", "hasMore"]) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw protocolError("session/page returned an invalid page");
  }
  return parseWindow(
    value.records,
    value.hasMore,
    expectedLastSeq,
    "journal page",
    limits,
    profile,
  );
}

function parseWindow(
  records: unknown,
  hasMore: boolean,
  expectedLastSeq: number,
  label: string,
  limits: ResolvedOptions,
  profile: DeepSeekModernProfile,
): ParsedWindow {
  if (!Array.isArray(records)) throw protocolError(`${label} records must be an array`);
  if (records.length > limits.maxRecordsPerPage) {
    throw limitError(`${label} exceeded maxRecordsPerPage`);
  }
  const events: ModernJournalEvent[] = [];
  let retainedBytes = 0;
  const logicalLimit = expectedLastSeq < 0 ? 0 : expectedLastSeq + 1;
  for (const record of records) {
    assertWireBytes(record, limits.maxRecordBytes, `${label} record`);
    const remaining = Math.min(limits.maxEvents, logicalLimit) - events.length;
    const expanded = profile.parseHistoryRecord(record, remaining);
    const expandedBytes = expanded.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"),
      0,
    );
    if (expandedBytes > limits.maxHistoryBytes - retainedBytes) {
      throw limitError("journal history exceeded maxHistoryBytes");
    }
    retainedBytes += expandedBytes;
    events.push(...expanded);
  }
  if (expectedLastSeq === -1) {
    if (events.length !== 0 || hasMore) throw protocolError(`${label} is invalid for an empty log`);
    return { events, hasMore, retainedBytes };
  }
  if (events.length === 0) throw protocolError(`${label} omitted required events`);
  assertContiguous(events, label);
  if (events.at(-1)?.seq !== expectedLastSeq) {
    throw protocolError(`${label} overlaps or leaves a sequence gap`);
  }
  if (hasMore !== (events[0] as ModernJournalEvent).seq > 0) {
    throw protocolError(`${label} has an inconsistent hasMore boundary`);
  }
  return { events, hasMore, retainedBytes };
}

function parseLiveItem(
  value: unknown,
  limits: ResolvedOptions,
  profile: DeepSeekModernProfile,
): { readonly item: ModernJournalLiveItem; readonly retainedBytes: number } {
  const retainedBytes = assertWireBytes(value, limits.maxRecordBytes, "journal live record");
  return { item: profile.parseLiveItem(value), retainedBytes };
}

function parseProjections(
  value: unknown,
  cursor: number,
  maxBytes: number,
): ModernJournalProjections {
  assertWireBytes(value, maxBytes, "journal projections");
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["asOfSeq", "values"]) ||
    value.asOfSeq !== cursor ||
    !isRecord(value.values)
  ) {
    throw protocolError("journal snapshot has an invalid projection baseline");
  }
  assertJsonValue(value.values, "journal projection values");
  return value as unknown as ModernJournalProjections;
}

function assertContiguous(events: readonly ModernJournalEvent[], label: string): void {
  for (let index = 1; index < events.length; index += 1) {
    if (
      (events[index] as ModernJournalEvent).seq !==
      (events[index - 1] as ModernJournalEvent).seq + 1
    ) {
      throw protocolError(`${label} is not sequence-contiguous`);
    }
  }
}

function resolveOptions(options: ModernJournalOptions): ResolvedOptions {
  const resolved = {
    pageMaxMessages: options.pageMaxMessages ?? MODERN_JOURNAL_PAGE_MAX_MESSAGES,
    maxRecordsPerPage: options.maxRecordsPerPage ?? MODERN_JOURNAL_MAX_RECORDS_PER_PAGE,
    maxRecordBytes: options.maxRecordBytes ?? MODERN_JOURNAL_MAX_RECORD_BYTES,
    maxPageRequests: options.maxPageRequests ?? MODERN_JOURNAL_MAX_PAGE_REQUESTS,
    maxEvents: options.maxEvents ?? MODERN_JOURNAL_MAX_EVENTS,
    maxHistoryBytes: options.maxHistoryBytes ?? MODERN_JOURNAL_MAX_HISTORY_BYTES,
    maxBufferedLiveEvents: options.maxBufferedLiveEvents ?? MODERN_JOURNAL_MAX_BUFFERED_LIVE_EVENTS,
    maxBufferedLiveBytes: options.maxBufferedLiveBytes ?? MODERN_JOURNAL_MAX_BUFFERED_LIVE_BYTES,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  return resolved;
}

function assertWireBytes(value: unknown, maxBytes: number, label: string): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw protocolError(`${label} is not JSON-serializable`);
  }
  if (text === undefined) throw protocolError(`${label} is not a JSON value`);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw limitError(`${label} exceeded maxRecordBytes`);
  }
  return bytes;
}

function remoteResultError(
  endpoint: string,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  },
): ModernJournalError {
  const safe = sanitizeModernRemoteFailure(failure);
  return new ModernJournalError(
    "remoteError",
    `DeepSeek Harness ${endpoint} failed: ${safe.message}`,
    safe.code,
  );
}

function normalizeError(error: unknown, context: string): ModernJournalError {
  if (error instanceof ModernJournalError) return error;
  if (error instanceof DeepSeekV015ProtocolError) {
    return new ModernJournalError("protocolError", `${context}: ${error.message}`);
  }
  const remoteFailure =
    typeof error === "object" && error !== null ? Reflect.get(error, "remoteFailure") : undefined;
  if (
    isRecord(remoteFailure) &&
    typeof remoteFailure.code === "string" &&
    typeof remoteFailure.message === "string" &&
    isRecord(remoteFailure.details)
  ) {
    const safe = sanitizeModernRemoteFailure(
      remoteFailure as unknown as {
        readonly code: string;
        readonly message: string;
        readonly details: Record<string, unknown>;
      },
    );
    return new ModernJournalError("remoteError", `${context}: ${safe.message}`, safe.code);
  }
  if (error instanceof ModernRemoteConnectionError) {
    return new ModernJournalError(error.code, `${context}: ${error.message}`, error.nativeCode);
  }
  const sourceCode =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const code: ModernJournalErrorCode =
    sourceCode === "cancelled"
      ? "cancelled"
      : sourceCode === "protocolError"
        ? "protocolError"
        : "unavailable";
  const message = error instanceof Error ? error.message : String(error);
  return new ModernJournalError(code, `${context}: ${message}`);
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => (promise ??= action());
}

async function nextBeforeAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new ModernJournalError("unavailable", "journal opening timed out");
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new ModernJournalError("unavailable", "journal opening timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class LiveBuffer implements AsyncIterable<ModernJournalLiveItem> {
  readonly #items: Array<{
    readonly event: ModernJournalLiveItem;
    readonly retainedBytes: number;
  }> = [];
  #retainedBytes = 0;
  #done = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;
  #claimed = false;

  constructor(
    readonly maxItems: number,
    readonly maxBytes: number,
  ) {}

  push(event: ModernJournalLiveItem, retainedBytes: number): void {
    if (this.#done || this.#failure) return;
    if (this.#items.length >= this.maxItems) {
      throw limitError("journal live buffer exceeded maxBufferedLiveEvents");
    }
    if (retainedBytes > this.maxBytes - this.#retainedBytes) {
      throw limitError("journal live buffer exceeded maxBufferedLiveBytes");
    }
    this.#items.push({ event, retainedBytes });
    this.#retainedBytes += retainedBytes;
    this.#notify();
  }

  fail(error: Error): void {
    if (this.#done || this.#failure) return;
    this.#failure = error;
    this.#items.length = 0;
    this.#retainedBytes = 0;
    this.#notify();
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    this.#items.length = 0;
    this.#retainedBytes = 0;
    this.#notify();
  }

  [Symbol.asyncIterator](): AsyncIterator<ModernJournalLiveItem> {
    if (this.#claimed) throw protocolError("journal live buffer is single-use");
    this.#claimed = true;
    return { next: () => this.#next() };
  }

  async #next(): Promise<IteratorResult<ModernJournalLiveItem>> {
    while (this.#items.length === 0 && !this.#done && !this.#failure) {
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    if (this.#failure) throw this.#failure;
    const item = this.#items.shift();
    if (!item) return { done: true, value: undefined };
    this.#retainedBytes -= item.retainedBytes;
    return { done: false, value: item.event };
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
