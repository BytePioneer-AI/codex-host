import { isDeepStrictEqual } from "node:util";

import { ModernRemoteConnectionError } from "./remote-connection.js";
import { redactModernCredential } from "./wire.js";

export type ModernControlJsonValue =
  | null
  | boolean
  | number
  | string
  | ModernControlJsonValue[]
  | { readonly [key: string]: ModernControlJsonValue };

export interface ModernProjectionRow {
  readonly value: ModernControlJsonValue;
  readonly seq: number;
}

export interface ModernProjectionSeed {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ModernControlStreamSource {
  openStream<T>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): AsyncIterable<T>;
}

export type ModernControlStoreErrorCode =
  | "authenticationRequired"
  | "cancelled"
  | "closed"
  | "detached"
  | "notInstalled"
  | "processExited"
  | "protocolError"
  | "resourceLimit"
  | "timeout"
  | "unavailable";

export class ModernControlStoreError extends Error {
  constructor(
    readonly code: ModernControlStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(redactModernCredential(message));
    void options;
    this.name = "ModernControlStoreError";
  }
}

export interface ModernControlStoreOptions {
  readonly maxSessions?: number;
  readonly maxKeysPerSession?: number;
  readonly maxWaiters?: number;
  readonly waitTimeoutMs?: number;
  readonly recoveryOpenTimeoutMs?: number;
  readonly onFault?: (error: ModernControlStoreError) => void;
}

export interface ModernProjectionWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface SessionState {
  readonly rows: Map<string, ModernProjectionRow>;
  readonly rowBytes: Map<string, number>;
  readonly listeners: Map<string, Set<(row: ModernProjectionRow | undefined) => void>>;
  bytes: number;
  seeded: boolean;
}

interface ProjectionWaiter {
  readonly sessionId: string;
  readonly key: string;
  readonly afterSeq: number;
  readonly predicate: (value: ModernControlJsonValue) => boolean;
  readonly resolve: (row: ModernProjectionRow) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: NodeJS.Timeout;
  settled: boolean;
}

interface ParsedProjectionBaseline {
  readonly asOfSeq: number;
  readonly values: Readonly<Record<string, ModernControlJsonValue>>;
  readonly rowBytes: Readonly<Record<string, number>>;
}

interface ParsedControlBaseline {
  readonly projections: Readonly<Record<string, ParsedProjectionBaseline>>;
}

type ParsedControlFrame =
  | { readonly type: "baseline"; readonly value: ParsedControlBaseline }
  | {
      readonly type: "projection";
      readonly sessionId: string;
      readonly key: string;
      readonly value: ModernControlJsonValue;
      readonly seq: number;
      readonly bytes: number;
    }
  | { readonly type: "queue"; readonly sessionId: string }
  | { readonly type: "jobs"; readonly sessionId: string };

const DEFAULT_MAX_SESSIONS = 1_024;
const DEFAULT_MAX_KEYS_PER_SESSION = 256;
const DEFAULT_MAX_WAITERS = 512;
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;
const MAX_COLLECTION_ITEMS = 4_096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_SESSION_PROJECTION_BYTES = 4 * 1024 * 1024;
const MAX_ID_LENGTH = 512;
const MAX_KEY_LENGTH = 256;

function storeError(code: ModernControlStoreErrorCode, message: string): ModernControlStoreError {
  return new ModernControlStoreError(code, message);
}

function transportError(error: ModernRemoteConnectionError): ModernControlStoreError {
  return storeError(error.code, `DeepSeek Harness control stream failed: ${error.message}`);
}

async function nextControlFrame(
  iterator: AsyncIterator<unknown>,
  lifetime: AbortSignal,
  timeoutMs: number,
): Promise<IteratorResult<unknown>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([lifetime, timeout]);
  if (signal.aborted) {
    throw storeError("unavailable", "DeepSeek Harness replacement control baseline timed out");
  }
  return await new Promise<IteratorResult<unknown>>((resolve, reject) => {
    const onAbort = (): void => {
      reject(storeError("unavailable", "DeepSeek Harness replacement control baseline timed out"));
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

function sanitizedError(error: unknown, fallback: string): Error {
  if (error instanceof ModernControlStoreError) return error;
  const failure = new Error(
    redactModernCredential(error instanceof Error ? error.message : fallback),
  );
  failure.name = redactModernCredential(error instanceof Error ? error.name : "Error");
  return failure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
  );
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 through ${String(maximum)}`);
  }
  return value;
}

function validCursor(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
  );
}

function validSeq(value: unknown): value is number {
  return validCursor(value) && value >= 0;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validProjectionKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_KEY_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    ) {
      bytes += 2;
    } else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
          if (bytes > MAX_SESSION_PROJECTION_BYTES) break;
          continue;
        }
      }
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_SESSION_PROJECTION_BYTES) break;
  }
  return bytes;
}

interface JsonBudget {
  nodes: number;
}

function measureJson(
  value: unknown,
  budget: JsonBudget = { nodes: 0 },
): { readonly value: ModernControlJsonValue; readonly bytes: number } {
  let bytes = 0;
  const seen = new Set<object>();
  const add = (amount: number): void => {
    bytes += amount;
    if (bytes > MAX_SESSION_PROJECTION_BYTES) {
      throw storeError(
        "resourceLimit",
        "DeepSeek Harness Session projections exceeded their byte limit",
      );
    }
  };
  const visit = (candidate: unknown, depth: number): void => {
    budget.nodes += 1;
    if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw storeError("resourceLimit", "DeepSeek Harness control JSON exceeded its bound");
    }
    if (candidate === null) {
      add(4);
      return;
    }
    if (typeof candidate === "boolean") {
      add(candidate ? 4 : 5);
      return;
    }
    if (typeof candidate === "string") {
      add(jsonStringBytes(candidate));
      return;
    }
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) {
        add(String(candidate).length);
        return;
      }
      throw storeError("protocolError", "DeepSeek Harness control frame contains non-JSON data");
    }
    if (typeof candidate !== "object" || candidate === null) {
      throw storeError("protocolError", "DeepSeek Harness control frame contains non-JSON data");
    }
    if (seen.has(candidate)) {
      throw storeError("protocolError", "DeepSeek Harness control frame contains cyclic data");
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_COLLECTION_ITEMS) {
        throw storeError("resourceLimit", "DeepSeek Harness control array exceeded its bound");
      }
      add(2 + Math.max(0, candidate.length - 1));
      for (const item of candidate) visit(item, depth + 1);
    } else {
      if (!isPlainRecord(candidate)) {
        throw storeError("protocolError", "DeepSeek Harness control frame contains non-JSON data");
      }
      const keys = Reflect.ownKeys(candidate);
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== "string") {
          throw storeError(
            "protocolError",
            "DeepSeek Harness control frame contains non-JSON data",
          );
        }
        add(jsonStringBytes(key) + 1);
        visit(candidate[key], depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  return { value: value as ModernControlJsonValue, bytes };
}

function measureProjection(
  key: string,
  value: unknown,
  budget?: JsonBudget,
): { readonly value: ModernControlJsonValue; readonly bytes: number } {
  const measured = measureJson(value, budget);
  return { value: measured.value, bytes: jsonStringBytes(key) + 1 + measured.bytes };
}

function projectionMapBytes(rowBytes: ReadonlyMap<string, number>): number {
  return (
    2 +
    Math.max(0, rowBytes.size - 1) +
    [...rowBytes.values()].reduce((sum, value) => sum + value, 0)
  );
}

function assertSessionProjectionBytes(bytes: number): void {
  if (bytes > MAX_SESSION_PROJECTION_BYTES) {
    throw storeError(
      "resourceLimit",
      "DeepSeek Harness Session projections exceeded their byte limit",
    );
  }
}

function freezeJson(value: ModernControlJsonValue): ModernControlJsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function detachedJson(value: ModernControlJsonValue): ModernControlJsonValue {
  return freezeJson(structuredClone(value) as ModernControlJsonValue);
}

function projectionRow(value: ModernControlJsonValue, seq: number): ModernProjectionRow {
  return Object.freeze({ value: detachedJson(value), seq });
}

function parseProjectionBaseline(value: unknown, maxKeys: number): ParsedProjectionBaseline {
  if (!isRecord(value) || !hasExactKeys(value, ["asOfSeq", "values"])) {
    throw storeError("protocolError", "DeepSeek Harness control baseline has invalid projections");
  }
  if (!validCursor(value.asOfSeq) || !isPlainRecord(value.values)) {
    throw storeError("protocolError", "DeepSeek Harness control baseline has invalid projections");
  }
  const keys = Object.keys(value.values);
  if (keys.length > maxKeys) {
    throw storeError("resourceLimit", "DeepSeek Harness projection key limit was exceeded");
  }
  const values: Record<string, ModernControlJsonValue> = Object.create(null) as Record<
    string,
    ModernControlJsonValue
  >;
  const rowBytes: Record<string, number> = Object.create(null) as Record<string, number>;
  const budget = { nodes: 0 };
  for (const key of keys) {
    if (!validProjectionKey(key)) {
      throw storeError("protocolError", "DeepSeek Harness control baseline has an invalid key");
    }
    const projection = measureProjection(key, value.values[key], budget);
    rowBytes[key] = projection.bytes;
    values[key] = projection.value;
  }
  const bytes = projectionMapBytes(new Map(Object.entries(rowBytes)));
  assertSessionProjectionBytes(bytes);
  return { asOfSeq: value.asOfSeq, values, rowBytes };
}

function parseQueueItem(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactOptionalKeys(value, ["id", "placement", "message"], ["rpcId"]) ||
    !validIdentifier(value.id) ||
    (value.placement !== "queued" &&
      value.placement !== "steering" &&
      value.placement !== "context") ||
    (value.rpcId !== undefined && !validIdentifier(value.rpcId)) ||
    !isRecord(value.message) ||
    !hasExactKeys(value.message, ["id", "content"]) ||
    !validIdentifier(value.message.id) ||
    !Array.isArray(value.message.content)
  ) {
    throw storeError("protocolError", "DeepSeek Harness control frame has an invalid queue");
  }
  void measureJson(value.message.content);
}

function parseJob(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactOptionalKeys(
      value,
      ["id", "kind", "label", "status", "startedAt"],
      ["detail", "finishedAt"],
    ) ||
    !validIdentifier(value.id) ||
    !validIdentifier(value.kind) ||
    typeof value.label !== "string" ||
    (value.status !== "running" &&
      value.status !== "stopping" &&
      value.status !== "completed" &&
      value.status !== "killed" &&
      value.status !== "failed") ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    (value.detail !== undefined && typeof value.detail !== "string") ||
    (value.finishedAt !== undefined &&
      (typeof value.finishedAt !== "number" || !Number.isSafeInteger(value.finishedAt)))
  ) {
    throw storeError("protocolError", "DeepSeek Harness control frame has invalid jobs");
  }
}

function parseSessionCollection(
  value: unknown,
  kind: "jobs" | "queues",
  sessions: Set<string>,
  maxSessions: number,
): void {
  if (!isPlainRecord(value)) {
    throw storeError("protocolError", `DeepSeek Harness control baseline has invalid ${kind}`);
  }
  for (const [sessionId, items] of Object.entries(value)) {
    if (!validIdentifier(sessionId) || !Array.isArray(items)) {
      throw storeError("protocolError", `DeepSeek Harness control baseline has invalid ${kind}`);
    }
    sessions.add(sessionId);
    if (sessions.size > maxSessions || items.length > MAX_COLLECTION_ITEMS) {
      throw storeError("resourceLimit", "DeepSeek Harness control baseline exceeded its bound");
    }
    for (const item of items) {
      if (kind === "queues") parseQueueItem(item);
      else parseJob(item);
    }
  }
}

function parseBaseline(
  value: unknown,
  maxSessions: number,
  maxKeys: number,
): ParsedControlBaseline {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["queues", "jobs", "projections"]) ||
    !isPlainRecord(value.projections)
  ) {
    throw storeError(
      "protocolError",
      "DeepSeek Harness control stream emitted an invalid baseline",
    );
  }
  const sessions = new Set<string>();
  parseSessionCollection(value.queues, "queues", sessions, maxSessions);
  parseSessionCollection(value.jobs, "jobs", sessions, maxSessions);
  const projections: Record<string, ParsedProjectionBaseline> = Object.create(null) as Record<
    string,
    ParsedProjectionBaseline
  >;
  for (const [sessionId, block] of Object.entries(value.projections)) {
    if (!validIdentifier(sessionId)) {
      throw storeError("protocolError", "DeepSeek Harness control baseline has an invalid Session");
    }
    sessions.add(sessionId);
    if (sessions.size > maxSessions) {
      throw storeError(
        "resourceLimit",
        "DeepSeek Harness control baseline exceeded its Session limit",
      );
    }
    projections[sessionId] = parseProjectionBaseline(block, maxKeys);
  }
  return { projections };
}

function parseControlFrame(
  value: unknown,
  maxSessions: number,
  maxKeys: number,
): ParsedControlFrame {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw storeError("protocolError", "DeepSeek Harness control stream emitted an invalid frame");
  }
  if (value.type === "baseline" && hasExactKeys(value, ["type", "value"])) {
    return { type: "baseline", value: parseBaseline(value.value, maxSessions, maxKeys) };
  }
  if (
    value.type === "projection" &&
    hasExactKeys(value, ["type", "sessionId", "key", "value", "seq"]) &&
    validIdentifier(value.sessionId) &&
    validProjectionKey(value.key) &&
    validSeq(value.seq)
  ) {
    const projection = measureProjection(value.key, value.value);
    return {
      type: "projection",
      sessionId: value.sessionId,
      key: value.key,
      value: projection.value,
      seq: value.seq,
      bytes: projection.bytes,
    };
  }
  if (
    value.type === "queue" &&
    hasExactKeys(value, ["type", "sessionId", "items"]) &&
    validIdentifier(value.sessionId) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_COLLECTION_ITEMS
  ) {
    for (const item of value.items) parseQueueItem(item);
    return { type: "queue", sessionId: value.sessionId };
  }
  if (
    value.type === "jobs" &&
    hasExactKeys(value, ["type", "sessionId", "jobs"]) &&
    validIdentifier(value.sessionId) &&
    Array.isArray(value.jobs) &&
    value.jobs.length <= MAX_COLLECTION_ITEMS
  ) {
    for (const job of value.jobs) parseJob(job);
    return { type: "jobs", sessionId: value.sessionId };
  }
  throw storeError("protocolError", "DeepSeek Harness control stream emitted an invalid frame");
}

function parseSeed(value: ModernProjectionSeed, maxKeys: number): ParsedProjectionBaseline {
  return parseProjectionBaseline(value, maxKeys);
}

/** Projection-only owner for the Modern Adapter-wide `session/control` stream. */
export class ModernControlStore {
  readonly #lifetime = new AbortController();
  readonly #maxKeys: number;
  readonly #maxSessions: number;
  readonly #maxWaiters: number;
  readonly #onFault: ((error: ModernControlStoreError) => void) | undefined;
  readonly #sessions = new Map<string, SessionState>();
  readonly #source: ModernControlStreamSource;
  readonly #waiters = new Set<ProjectionWaiter>();
  readonly #waitTimeoutMs: number;
  readonly #recoveryOpenTimeoutMs: number;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #fault: ModernControlStoreError | undefined;
  #iterator: AsyncIterator<unknown> | undefined;
  #opened = false;
  #pump: Promise<void> | undefined;
  #ready: Promise<void> | undefined;
  #readyReject: ((error: Error) => void) | undefined;
  #readyResolve: (() => void) | undefined;

  constructor(source: ModernControlStreamSource, options: ModernControlStoreOptions = {}) {
    this.#source = source;
    this.#maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, "maxSessions");
    this.#maxKeys = positiveInteger(
      options.maxKeysPerSession ?? DEFAULT_MAX_KEYS_PER_SESSION,
      "maxKeysPerSession",
    );
    this.#maxWaiters = positiveInteger(options.maxWaiters ?? DEFAULT_MAX_WAITERS, "maxWaiters");
    this.#waitTimeoutMs = positiveInteger(
      options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      "waitTimeoutMs",
      MAX_TIMER_MILLISECONDS,
    );
    this.#recoveryOpenTimeoutMs = positiveInteger(
      options.recoveryOpenTimeoutMs ?? this.#waitTimeoutMs,
      "recoveryOpenTimeoutMs",
      MAX_TIMER_MILLISECONDS,
    );
    this.#onFault = options.onFault;
  }

  get fault(): ModernControlStoreError | undefined {
    return this.#fault;
  }

  start(): Promise<void> {
    if (this.#closing) return Promise.reject(storeError("closed", "Control store is closed"));
    if (this.#fault) return Promise.reject(this.#fault);
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#pump = this.#run();
    return this.#ready;
  }

  attach(sessionId: string, seed?: ModernProjectionSeed): () => void {
    this.#assertUsable();
    if (!validIdentifier(sessionId)) throw new TypeError("sessionId is invalid");
    let parsedSeed: ParsedProjectionBaseline | undefined;
    if (seed) {
      try {
        parsedSeed = parseSeed(seed, this.#maxKeys);
      } catch (error) {
        const failure =
          error instanceof ModernControlStoreError
            ? error
            : new ModernControlStoreError("protocolError", "Invalid projection seed");
        this.#fail(failure);
        throw failure;
      }
    }
    let session = this.#sessions.get(sessionId);
    if (!session) {
      if (this.#sessions.size >= this.#maxSessions) {
        throw storeError("resourceLimit", "Control store Session limit was exceeded");
      }
      session = {
        rows: new Map(),
        rowBytes: new Map(),
        listeners: new Map(),
        bytes: 2,
        seeded: false,
      };
      this.#sessions.set(sessionId, session);
    }
    if (parsedSeed) this.#seed(sessionId, session, parsedSeed);
    return () => this.detach(sessionId);
  }

  /** Reconcile a durable journal baseline into an already-attached Session. */
  seed(sessionId: string, seed: ModernProjectionSeed): void {
    this.#assertUsable();
    const session = this.#sessions.get(sessionId);
    if (!session) throw storeError("detached", "DeepSeek Harness Session is not attached");
    try {
      this.#seed(sessionId, session, parseSeed(seed, this.#maxKeys));
    } catch (error) {
      const failure =
        error instanceof ModernControlStoreError
          ? error
          : new ModernControlStoreError("protocolError", "Invalid projection seed");
      this.#fail(failure);
      throw failure;
    }
  }

  detach(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.rows.clear();
    session.rowBytes.clear();
    session.bytes = 2;
    session.listeners.clear();
    this.#rejectWaiters(
      (waiter) => waiter.sessionId === sessionId,
      storeError("detached", "DeepSeek Harness Session detached from control state"),
    );
  }

  snapshot(sessionId: string): Readonly<Record<string, ModernProjectionRow>> | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    return Object.freeze(Object.fromEntries(session.rows));
  }

  subscribe(
    sessionId: string,
    key: string,
    listener: (row: ModernProjectionRow | undefined) => void,
  ): () => void {
    this.#assertUsable();
    if (!validProjectionKey(key)) throw new TypeError("projection key is invalid");
    const session = this.#sessions.get(sessionId);
    if (!session) throw storeError("detached", "DeepSeek Harness Session is not attached");
    let listeners = session.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      session.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) session.listeners.delete(key);
    };
  }

  waitFor(
    sessionId: string,
    key: string,
    afterSeq: number,
    predicate: (value: ModernControlJsonValue) => boolean,
    options: ModernProjectionWaitOptions = {},
  ): Promise<ModernProjectionRow> {
    try {
      this.#assertUsable();
      if (!validProjectionKey(key)) throw new TypeError("projection key is invalid");
      if (!validCursor(afterSeq)) throw new TypeError("afterSeq is invalid");
      if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
      const session = this.#sessions.get(sessionId);
      if (!session) throw storeError("detached", "DeepSeek Harness Session is not attached");
      if (options.signal?.aborted) {
        throw storeError("cancelled", "DeepSeek Harness projection wait was cancelled");
      }
      const existing = session.rows.get(key);
      if (existing && existing.seq > afterSeq) {
        try {
          if (predicate(existing.value)) return Promise.resolve(existing);
        } catch (error) {
          throw sanitizedError(error, "Projection predicate failed");
        }
      }
      if (this.#waiters.size >= this.#maxWaiters) {
        throw storeError("resourceLimit", "Control store waiter limit was exceeded");
      }
      const timeoutMs = positiveInteger(
        options.timeoutMs ?? this.#waitTimeoutMs,
        "timeoutMs",
        MAX_TIMER_MILLISECONDS,
      );
      return new Promise<ModernProjectionRow>((resolve, reject) => {
        const waiter: ProjectionWaiter = {
          sessionId,
          key,
          afterSeq,
          predicate,
          resolve,
          reject,
          ...(options.signal ? { signal: options.signal } : {}),
          settled: false,
        };
        waiter.timeout = setTimeout(() => {
          this.#settleWaiter(
            waiter,
            storeError("timeout", "DeepSeek Harness projection confirmation timed out"),
          );
        }, timeoutMs);
        if (options.signal) {
          const onAbort = (): void => {
            this.#settleWaiter(
              waiter,
              storeError("cancelled", "DeepSeek Harness projection wait was cancelled"),
            );
          };
          waiter.onAbort = onAbort;
          this.#waiters.add(waiter);
          options.signal.addEventListener("abort", onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        } else {
          this.#waiters.add(waiter);
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  replaceBaseline(frame: unknown): void {
    this.#assertUsable();
    try {
      const parsed = parseControlFrame(frame, this.#maxSessions, this.#maxKeys);
      if (parsed.type !== "baseline") {
        throw storeError("protocolError", "Control baseline replacement requires a baseline frame");
      }
      this.#replace(parsed.value, true);
    } catch (error) {
      const failure =
        error instanceof ModernControlStoreError
          ? error
          : new ModernControlStoreError("protocolError", "Invalid control baseline");
      this.#fail(failure);
      throw failure;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    this.#lifetime.abort(new Error("DeepSeek Harness control store closed"));
    this.#readyReject?.(storeError("closed", "Control store closed before its baseline"));
    this.#rejectWaiters(() => true, storeError("closed", "Control store is closed"));
    for (const sessionId of [...this.#sessions.keys()]) this.detach(sessionId);
    const returning = this.#iterator?.return?.();
    await Promise.allSettled([this.#pump, returning].filter(Boolean));
  }

  async #run(): Promise<void> {
    let replacementUsed = false;
    while (!this.#closing) {
      let iterator: AsyncIterator<unknown> | undefined;
      try {
        const iterable = this.#source.openStream<unknown>(
          "session/control",
          {},
          this.#lifetime.signal,
        );
        iterator = iterable[Symbol.asyncIterator]();
        this.#iterator = iterator;
        let generationOpened = false;
        for (;;) {
          const next = generationOpened
            ? await iterator.next()
            : await nextControlFrame(iterator, this.#lifetime.signal, this.#recoveryOpenTimeoutMs);
          if (next.done) {
            if (this.#closing) return;
            throw storeError(
              this.#opened ? "unavailable" : "protocolError",
              this.#opened
                ? "DeepSeek Harness control stream ended unexpectedly"
                : "DeepSeek Harness control stream ended before its baseline",
            );
          }
          const frame = parseControlFrame(next.value, this.#maxSessions, this.#maxKeys);
          if (!generationOpened && frame.type !== "baseline") {
            throw storeError(
              "protocolError",
              "DeepSeek Harness control stream omitted its baseline",
            );
          }
          if (frame.type === "baseline") {
            if (generationOpened) {
              throw storeError(
                "protocolError",
                "DeepSeek Harness control stream emitted a second physical baseline",
              );
            }
            this.#replace(frame.value, this.#opened);
            generationOpened = true;
            if (!this.#opened) {
              this.#opened = true;
              this.#readyResolve?.();
            }
          } else if (frame.type === "projection") {
            this.#apply(frame.sessionId, frame.key, frame.value, frame.seq, frame.bytes);
            if (this.#fault) return;
          }
          // queue/jobs are validated transport facts but this store deliberately owns no such state.
        }
      } catch (error) {
        if (this.#closing) return;
        const failure =
          error instanceof ModernControlStoreError
            ? error
            : error instanceof ModernRemoteConnectionError
              ? transportError(error)
              : new ModernControlStoreError(
                  "unavailable",
                  "DeepSeek Harness control stream failed",
                );
        if (this.#opened && !replacementUsed && failure.code === "unavailable") {
          replacementUsed = true;
          continue;
        }
        this.#fail(failure);
        return;
      } finally {
        if (iterator && !this.#closing) await Promise.allSettled([iterator.return?.()]);
        if (this.#iterator === iterator) this.#iterator = undefined;
      }
    }
  }

  #replace(baseline: ParsedControlBaseline, requireComplete = false): void {
    const replacements: Array<{
      readonly sessionId: string;
      readonly session: SessionState;
      readonly next: Map<string, ModernProjectionRow>;
      readonly nextRowBytes: Map<string, number>;
      readonly nextBytes: number;
      readonly changed: string[];
    }> = [];
    for (const [sessionId, session] of this.#sessions) {
      const block = baseline.projections[sessionId];
      if (!block) {
        if (requireComplete && session.seeded) {
          throw storeError(
            "protocolError",
            "DeepSeek Harness replacement baseline omitted an attached Session",
          );
        }
        continue;
      }
      if (requireComplete && session.seeded) {
        const committedWatermark = Math.max(
          -1,
          ...[...session.rows.values()].map(({ seq }) => seq),
        );
        if (block.asOfSeq < committedWatermark) {
          throw storeError(
            "protocolError",
            "DeepSeek Harness replacement baseline is behind an attached Session watermark",
          );
        }
      }
      const { next, nextRowBytes, nextBytes, changed } = this.#reconcile(session, block);
      replacements.push({ sessionId, session, next, nextRowBytes, nextBytes, changed });
    }
    for (const { session, next, nextRowBytes, nextBytes } of replacements) {
      session.rows.clear();
      for (const [key, row] of next) session.rows.set(key, row);
      session.rowBytes.clear();
      for (const [key, bytes] of nextRowBytes) session.rowBytes.set(key, bytes);
      session.bytes = nextBytes;
    }
    for (const { sessionId, session, changed } of replacements) {
      for (const key of changed) this.#changed(sessionId, session, key);
    }
  }

  #seed(sessionId: string, session: SessionState, seed: ParsedProjectionBaseline): void {
    try {
      const { next, nextRowBytes, nextBytes, changed } = this.#reconcile(session, seed);
      session.rows.clear();
      for (const [key, row] of next) session.rows.set(key, row);
      session.rowBytes.clear();
      for (const [key, bytes] of nextRowBytes) session.rowBytes.set(key, bytes);
      session.bytes = nextBytes;
      session.seeded = true;
      for (const key of changed) this.#changed(sessionId, session, key);
    } catch (error) {
      const failure =
        error instanceof ModernControlStoreError
          ? error
          : new ModernControlStoreError("protocolError", "Projection seed reconciliation failed");
      this.#fail(failure);
      throw failure;
    }
  }

  #reconcile(
    session: SessionState,
    baseline: ParsedProjectionBaseline,
  ): {
    readonly next: Map<string, ModernProjectionRow>;
    readonly nextRowBytes: Map<string, number>;
    readonly nextBytes: number;
    readonly changed: string[];
  } {
    const next = new Map<string, ModernProjectionRow>();
    const nextRowBytes = new Map<string, number>();
    for (const [key, value] of Object.entries(baseline.values)) {
      const current = session.rows.get(key);
      if (current) {
        if (current.seq > baseline.asOfSeq) {
          next.set(key, current);
          nextRowBytes.set(key, session.rowBytes.get(key) as number);
          continue;
        }
        if (current.seq === baseline.asOfSeq) {
          if (!isDeepStrictEqual(current.value, value)) {
            throw storeError(
              "protocolError",
              "DeepSeek Harness control baseline conflicts at the same projection sequence",
            );
          }
          next.set(key, current);
          nextRowBytes.set(key, session.rowBytes.get(key) as number);
          continue;
        }
      }
      next.set(key, projectionRow(value, baseline.asOfSeq));
      nextRowBytes.set(key, baseline.rowBytes[key] as number);
    }
    for (const [key, current] of session.rows) {
      if (next.has(key)) continue;
      if (current.seq > baseline.asOfSeq) {
        next.set(key, current);
        nextRowBytes.set(key, session.rowBytes.get(key) as number);
      } else if (current.seq === baseline.asOfSeq) {
        throw storeError(
          "protocolError",
          "DeepSeek Harness control baseline omits a same-sequence projection",
        );
      }
    }
    if (next.size > this.#maxKeys) {
      throw storeError("resourceLimit", "DeepSeek Harness projection key limit was exceeded");
    }
    const nextBytes = projectionMapBytes(nextRowBytes);
    assertSessionProjectionBytes(nextBytes);
    const keys = new Set([...session.rows.keys(), ...next.keys()]);
    return {
      next,
      nextRowBytes,
      nextBytes,
      changed: [...keys].filter((key) => {
        const before = session.rows.get(key);
        const after = next.get(key);
        return before?.seq !== after?.seq || !isDeepStrictEqual(before?.value, after?.value);
      }),
    };
  }

  #apply(
    sessionId: string,
    key: string,
    value: ModernControlJsonValue,
    seq: number,
    bytes: number,
  ): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    const current = session.rows.get(key);
    if (current) {
      if (seq < current.seq) return;
      if (seq === current.seq) {
        if (isDeepStrictEqual(current.value, value)) return;
        this.#fail(
          storeError("protocolError", "DeepSeek Harness projection conflicts at the same sequence"),
        );
        return;
      }
    } else if (session.rows.size >= this.#maxKeys) {
      this.#fail(storeError("resourceLimit", "DeepSeek Harness projection key limit was exceeded"));
      return;
    }
    const previousBytes = session.rowBytes.get(key);
    const nextBytes =
      session.bytes -
      (previousBytes ?? 0) +
      bytes +
      (previousBytes === undefined && session.rows.size > 0 ? 1 : 0);
    if (nextBytes > MAX_SESSION_PROJECTION_BYTES) {
      this.#fail(
        storeError(
          "resourceLimit",
          "DeepSeek Harness Session projections exceeded their byte limit",
        ),
      );
      return;
    }
    session.rows.set(key, projectionRow(value, seq));
    session.rowBytes.set(key, bytes);
    session.bytes = nextBytes;
    this.#changed(sessionId, session, key);
  }

  #changed(sessionId: string, session: SessionState, key: string): void {
    const row = session.rows.get(key);
    for (const listener of session.listeners.get(key) ?? []) {
      try {
        listener(row);
      } catch {
        // A local observer cannot corrupt the authoritative control state.
      }
    }
    for (const waiter of [...this.#waiters]) {
      if (
        waiter.sessionId !== sessionId ||
        waiter.key !== key ||
        !row ||
        row.seq <= waiter.afterSeq
      )
        continue;
      try {
        if (waiter.predicate(row.value)) this.#settleWaiter(waiter, row);
      } catch (error) {
        this.#settleWaiter(waiter, sanitizedError(error, "Projection predicate failed"));
      }
    }
  }

  #settleWaiter(waiter: ProjectionWaiter, outcome: ModernProjectionRow | Error): void {
    if (waiter.settled) return;
    waiter.settled = true;
    this.#waiters.delete(waiter);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  }

  #rejectWaiters(predicate: (waiter: ProjectionWaiter) => boolean, error: Error): void {
    for (const waiter of [...this.#waiters]) {
      if (predicate(waiter)) this.#settleWaiter(waiter, error);
    }
  }

  #fail(error: ModernControlStoreError): void {
    if (this.#fault || this.#closing) return;
    this.#fault = error;
    this.#lifetime.abort(error);
    this.#readyReject?.(error);
    this.#rejectWaiters(() => true, error);
    void this.#iterator?.return?.().catch(() => undefined);
    try {
      this.#onFault?.(error);
    } catch {
      // Adapter fault observers cannot replace the authoritative store fault.
    }
  }

  #assertUsable(): void {
    if (this.#fault) throw this.#fault;
    if (this.#closing) throw storeError("closed", "Control store is closed");
  }
}
