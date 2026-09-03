/** Strict, single-generation DeepSeek Harness Modern Session journal reader. */

import { ModernRemoteConnectionError } from "./remote-connection.js";
import {
  redactModernCredential,
  sanitizeModernRemoteFailure,
  type ModernRemoteResult,
} from "./wire.js";

export const MODERN_JOURNAL_PAGE_MAX_MESSAGES = 200;
export const MODERN_JOURNAL_MAX_RECORDS_PER_PAGE = 100_000;
export const MODERN_JOURNAL_MAX_RECORD_BYTES = 32 * 1024 * 1024;
export const MODERN_JOURNAL_MAX_PAGE_REQUESTS = 10_000;
export const MODERN_JOURNAL_MAX_EVENTS = 1_000_000;
export const MODERN_JOURNAL_MAX_HISTORY_BYTES = 128 * 1024 * 1024;
export const MODERN_JOURNAL_MAX_BUFFERED_LIVE_EVENTS = 8_192;
export const MODERN_JOURNAL_MAX_BUFFERED_LIVE_BYTES = 32 * 1024 * 1024;
export const MODERN_JOURNAL_RECOVERY_OPEN_TIMEOUT_MS = 10_000;
const MODERN_JOURNAL_MAX_JSON_DEPTH = 100;

export type ModernJournalJson =
  | null
  | boolean
  | number
  | string
  | readonly ModernJournalJson[]
  | { readonly [key: string]: ModernJournalJson };

export interface ModernJournalHeader {
  readonly version: 0;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: "subagent";
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export type ModernJournalSurfaceOp =
  "append" | { readonly op: "replace"; readonly start: number; readonly end: number };

/** Generic event envelope; unknown event names remain available to the projector. */
export interface ModernJournalEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: ModernJournalJson;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?: ModernJournalSurfaceOp;
}

export interface ModernJournalProjections {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, ModernJournalJson>>;
}

export interface ModernJournal {
  readonly header: ModernJournalHeader;
  readonly cursor: number;
  readonly projections: ModernJournalProjections;
  readonly events: readonly ModernJournalEvent[];
  readonly live: AsyncIterable<ModernJournalEvent>;
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

export type ModernJournalErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "limitExceeded"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "remoteError"
  | "unavailable";

export class ModernJournalError extends Error {
  readonly nativeCode?: string;

  constructor(
    readonly code: ModernJournalErrorCode,
    message: string,
    nativeCode?: string,
  ) {
    super(redactModernCredential(message));
    this.name = "ModernJournalError";
    if (nativeCode !== undefined) this.nativeCode = redactModernCredential(nativeCode);
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
        { request: { address, maxMessages: limits.pageMaxMessages } },
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
    opening = parseOpeningSnapshot(first.value, request, limits);
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
  let closing = false;
  let pumpFailure: ModernJournalError | undefined;
  let expectedLiveSeq = opening.cursor + 1;
  const pump = (async (): Promise<void> => {
    try {
      while (!closing) {
        const item = await iterator.next();
        if (item.done) {
          if (closing) break;
          throw new ModernJournalError("unavailable", "journal follow ended unexpectedly");
        }
        const { event, retainedBytes } = parseLiveEvent(item.value, limits);
        if (event.seq !== expectedLiveSeq) {
          throw protocolError("journal live events are not sequence-contiguous");
        }
        expectedLiveSeq += 1;
        reserveHistoryBytes(retainedBytes);
        liveBuffer.push(event, retainedBytes);
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
      const page = parsePage(result.value, oldestSeq - 1, limits);
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

    let liveClaimed = false;
    const live: AsyncIterable<ModernJournalEvent> = {
      [Symbol.asyncIterator](): AsyncIterator<ModernJournalEvent> {
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
      header: opening.header,
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
): {
  readonly header: ModernJournalHeader;
  readonly cursor: number;
  readonly events: ModernJournalEvent[];
  readonly hasMore: boolean;
  readonly projections: ModernJournalProjections;
  readonly retainedBytes: number;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "header", "cursor", "records", "hasMore", "projections"]) ||
    value.type !== "snapshot" ||
    !isCursor(value.cursor) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw protocolError("journal follow emitted an invalid opening snapshot");
  }
  if (value.cursor + 1 > limits.maxEvents) {
    throw limitError("journal opening cursor exceeded maxEvents");
  }
  const header = parseHeader(value.header, request, limits.maxRecordBytes);
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
  );
  return {
    header,
    cursor: value.cursor,
    events: window.events,
    hasMore: window.hasMore,
    projections,
    retainedBytes: window.retainedBytes,
  };
}

function parsePage(value: unknown, expectedLastSeq: number, limits: ResolvedOptions): ParsedWindow {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["records", "hasMore"]) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw protocolError("session/page returned an invalid page");
  }
  return parseWindow(value.records, value.hasMore, expectedLastSeq, "journal page", limits);
}

function parseWindow(
  records: unknown,
  hasMore: boolean,
  expectedLastSeq: number,
  label: string,
  limits: ResolvedOptions,
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
    const expanded = parseHistoryRecord(record, remaining);
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

function parseHistoryRecord(value: unknown, remainingEvents: number): ModernJournalEvent[] {
  if (remainingEvents < 1) throw limitError("journal history exceeded its logical event bound");
  if (!isRecord(value) || !hasExactKeys(value, ["type", "event"])) {
    throw protocolError("journal history record has an invalid envelope");
  }
  if (value.type === "event") return [parseEvent(value.event)];
  if (value.type === "chunks") return expandChunkRow(value.event, remainingEvents);
  throw protocolError("journal history record has an unknown kind");
}

function parseLiveEvent(
  value: unknown,
  limits: ResolvedOptions,
): { readonly event: ModernJournalEvent; readonly retainedBytes: number } {
  const retainedBytes = assertWireBytes(value, limits.maxRecordBytes, "journal live record");
  if (!isRecord(value) || !hasExactKeys(value, ["type", "event"]) || value.type !== "event") {
    throw protocolError("journal live follow emitted a non-event frame");
  }
  return { event: parseEvent(value.event), retainedBytes };
}

function parseEvent(value: unknown): ModernJournalEvent {
  if (
    !isRecord(value) ||
    !hasRequiredOptionalKeys(
      value,
      ["type", "seq", "time", "data"],
      ["ignorable", "sourceEventSeqs", "surfaceOp"],
    )
  ) {
    throw protocolError("journal event has an invalid envelope");
  }
  if (
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    !isSeq(value.seq) ||
    !Number.isSafeInteger(value.time) ||
    (Object.hasOwn(value, "ignorable") && value.ignorable !== true)
  ) {
    throw protocolError("journal event has invalid scalar fields");
  }
  assertJsonValue(value.data, "journal event data");
  if (Object.hasOwn(value, "sourceEventSeqs")) {
    if (
      !Array.isArray(value.sourceEventSeqs) ||
      value.sourceEventSeqs.some((seq) => !isSeq(seq) || seq >= (value.seq as number)) ||
      new Set(value.sourceEventSeqs).size !== value.sourceEventSeqs.length
    ) {
      throw protocolError("journal event has invalid sourceEventSeqs");
    }
  }
  if (Object.hasOwn(value, "surfaceOp")) parseSurfaceOp(value.surfaceOp);
  return value as unknown as ModernJournalEvent;
}

function parseSurfaceOp(value: unknown): ModernJournalSurfaceOp {
  if (value === "append") return value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["op", "start", "end"]) ||
    value.op !== "replace" ||
    !isSeq(value.start) ||
    !isSeq(value.end)
  ) {
    throw protocolError("journal event has an invalid surfaceOp");
  }
  return value as unknown as ModernJournalSurfaceOp;
}

function expandChunkRow(value: unknown, remainingEvents: number): ModernJournalEvent[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "seq", "time", "data"]) ||
    typeof value.type !== "string" ||
    !["chunkrow/text-chunks", "chunkrow/reasoning-chunks", "chunkrow/tool-call-chunks"].includes(
      value.type,
    ) ||
    !isSeq(value.seq) ||
    !Number.isSafeInteger(value.time) ||
    !isRecord(value.data)
  ) {
    throw protocolError("journal chunk row has an invalid envelope");
  }
  const data = value.data;
  const tool = value.type === "chunkrow/tool-call-chunks";
  const withName = tool && Object.hasOwn(data, "name");
  const expectedDataKeys = tool
    ? withName
      ? ["turn", "step", "index", "id", "name", "dt", "args"]
      : ["turn", "step", "index", "id", "dt", "args"]
    : ["turn", "step", "index", "dt", "texts"];
  if (
    !hasExactKeys(data, expectedDataKeys) ||
    !isFiniteNumber(data.turn) ||
    !isFiniteNumber(data.step) ||
    !isFiniteNumber(data.index) ||
    (tool && (typeof data.id !== "string" || (withName && typeof data.name !== "string")))
  ) {
    throw protocolError("journal chunk row has invalid data fields");
  }
  const payload = data[tool ? "args" : "texts"];
  const dt = data.dt;
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    payload.some((entry) => typeof entry !== "string") ||
    !Array.isArray(dt) ||
    dt.some((gap) => !Number.isSafeInteger(gap)) ||
    dt.length !== payload.length - 1
  ) {
    throw protocolError("journal chunk row has invalid member arrays");
  }
  const seq = value.seq as number;
  if (payload.length > remainingEvents) throw limitError("journal chunk row exceeded maxEvents");
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - seq) {
    throw protocolError("journal chunk row member sequences overflow");
  }
  const events: ModernJournalEvent[] = [];
  let time = value.time as number;
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) time += dt[index - 1] as number;
    if (!Number.isSafeInteger(time)) throw protocolError("journal chunk row member times overflow");
    const chunk = tool
      ? {
          type: "tool-call-delta",
          index: data.index,
          id: data.id,
          ...(withName ? { name: data.name } : {}),
          argumentsDelta: payload[index],
        }
      : {
          type: value.type === "chunkrow/text-chunks" ? "text-delta" : "reasoning-delta",
          index: data.index,
          text: payload[index],
        };
    events.push({
      type: "assistant/chunk",
      seq: seq + index,
      time,
      data: { turn: data.turn, step: data.step, chunk } as ModernJournalJson,
    });
  }
  return events;
}

function parseHeader(
  value: unknown,
  expected: ModernJournalOpenRequest,
  maxBytes: number,
): ModernJournalHeader {
  assertWireBytes(value, maxBytes, "journal header");
  if (
    !isRecord(value) ||
    !hasRequiredOptionalKeys(
      value,
      ["version", "id", "createdAt"],
      ["cwd", "parentSession", "seedLength", "origin", "delegationDepth", "agentPreset"],
    )
  ) {
    throw protocolError("journal snapshot has an invalid header");
  }
  if (
    value.version !== 0 ||
    value.id !== expected.sessionId ||
    !isNonNegativeSafeInteger(value.createdAt) ||
    Object.hasOwn(value, "cwd") !== (expected.cwd !== undefined) ||
    value.cwd !== expected.cwd ||
    (Object.hasOwn(value, "parentSession") && typeof value.parentSession !== "string") ||
    (Object.hasOwn(value, "seedLength") && !isNonNegativeSafeInteger(value.seedLength)) ||
    (Object.hasOwn(value, "origin") && value.origin !== "subagent") ||
    (Object.hasOwn(value, "delegationDepth") && !isNonNegativeSafeInteger(value.delegationDepth)) ||
    (Object.hasOwn(value, "agentPreset") && typeof value.agentPreset !== "string")
  ) {
    throw protocolError("journal snapshot header does not match the requested Session");
  }
  return value as unknown as ModernJournalHeader;
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

function assertJsonValue(value: unknown, label: string): asserts value is ModernJournalJson {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop() as { readonly value: unknown; readonly depth: number };
    const current = item.value;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object") throw protocolError(`${label} is not JSON-safe`);
    if (item.depth >= MODERN_JOURNAL_MAX_JSON_DEPTH) {
      throw limitError(`${label} exceeded its JSON depth bound`);
    }
    if (seen.has(current)) throw protocolError(`${label} contains a cycle`);
    seen.add(current);
    if (!Array.isArray(current)) {
      const prototype = Reflect.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw protocolError(`${label} contains a non-JSON object`);
      }
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string") throw protocolError(`${label} contains a symbol key`);
      pending.push({
        value: (current as Record<string, unknown>)[key],
        depth: item.depth + 1,
      });
    }
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasRequiredOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Reflect.ownKeys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isSeq(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

function isCursor(value: unknown): value is number {
  return value === -1 || isSeq(value);
}

function protocolError(message: string): ModernJournalError {
  return new ModernJournalError("protocolError", message);
}

function limitError(message: string): ModernJournalError {
  return new ModernJournalError("limitExceeded", message);
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

class LiveBuffer implements AsyncIterable<ModernJournalEvent> {
  readonly #items: Array<{ readonly event: ModernJournalEvent; readonly retainedBytes: number }> =
    [];
  #retainedBytes = 0;
  #done = false;
  #failure: Error | undefined;
  #wake: (() => void) | undefined;
  #claimed = false;

  constructor(
    readonly maxItems: number,
    readonly maxBytes: number,
  ) {}

  push(event: ModernJournalEvent, retainedBytes: number): void {
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

  [Symbol.asyncIterator](): AsyncIterator<ModernJournalEvent> {
    if (this.#claimed) throw protocolError("journal live buffer is single-use");
    this.#claimed = true;
    return { next: () => this.#next() };
  }

  async #next(): Promise<IteratorResult<ModernJournalEvent>> {
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
