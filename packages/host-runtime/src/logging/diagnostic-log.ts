import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

import { ThreadEventLog } from "./thread-event-log.js";

export const DIAGNOSTIC_LOG_LEVEL_ENV = "CODEXHOST_LOG_LEVEL";

export type DiagnosticLogLevel = "error" | "warn" | "info" | "debug";
export type DiagnosticLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly DiagnosticLogValue[]
  | { readonly [key: string]: DiagnosticLogValue };
export type DiagnosticLogFields = Readonly<Record<string, DiagnosticLogValue>>;

/** One file per External Thread; a full file is rotated once, so a Thread keeps at most 2x. */
export const DIAGNOSTIC_LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const RECORD_MAX_BYTES = 16 * 1024;
const STRING_MAX_CHARS = 2_000;
/** Native error text can echo prompts, commands, outputs, or credentials. Never persist it. */
const CONTENT_KEYS = new Set(["message", "diagnostic", "stderrTail", "cause", "cancelReason"]);
const COLLECTION_MAX_ENTRIES = 50;
const VALUE_MAX_DEPTH = 4;
const SENSITIVE_KEY =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|auth(orization)?|password|secret|cookie|credentials?)$/iu;
const SAFE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const LEVEL_RANK: Readonly<Record<DiagnosticLogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface DiagnosticLog {
  /** Absolute log root, or null when logging is off. */
  readonly directory: string | null;
  isEnabled(level: DiagnosticLogLevel): boolean;
  /** Process-level events that belong to no External Thread. */
  runtime(level: DiagnosticLogLevel, event: string, fields?: DiagnosticLogFields): void;
  /** Returns the per-Thread log and remembers the Thread as externally owned. */
  thread(hostThreadId: string, harnessId: string): ThreadEventLog;
  knownThread(hostThreadId: string): ThreadEventLog | undefined;
  forgetThread(hostThreadId: string): void;
  flush(): Promise<void>;
}

export function diagnosticLogDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  return path.join(dataDirectory, "logs");
}

export function diagnosticLogLevel(environment: NodeJS.ProcessEnv): DiagnosticLogLevel | "off" {
  const value = environment[DIAGNOSTIC_LOG_LEVEL_ENV]?.trim().toLowerCase();
  return value === "off" || (value !== undefined && Object.hasOwn(LEVEL_RANK, value))
    ? (value as DiagnosticLogLevel | "off")
    : "info";
}

export function createDiagnosticLog(environment: NodeJS.ProcessEnv): DiagnosticLog {
  const level = diagnosticLogLevel(environment);
  return level === "off"
    ? createDisabledDiagnosticLog()
    : new FileDiagnosticLog({ directory: diagnosticLogDirectory(environment), level });
}

export function createDisabledDiagnosticLog(): DiagnosticLog {
  return new FileDiagnosticLog({ directory: null, level: "error" });
}

export class FileDiagnosticLog implements DiagnosticLog {
  readonly directory: string | null;
  readonly #level: number;
  readonly #pid: number;
  readonly #runtimeFile: string | null;
  readonly #files = new LogFileAppender(DIAGNOSTIC_LOG_FILE_MAX_BYTES);
  readonly #threads = new Map<string, ThreadEventLog>();
  readonly #now: () => Date;

  constructor(input: {
    directory: string | null;
    level: DiagnosticLogLevel;
    now?: () => Date;
    pid?: number;
  }) {
    this.directory = input.directory;
    this.#level = input.directory === null ? -1 : LEVEL_RANK[input.level];
    this.#now = input.now ?? (() => new Date());
    this.#pid = input.pid ?? process.pid;
    const day = this.#now().toISOString().slice(0, 10).replaceAll("-", "");
    this.#runtimeFile = input.directory
      ? path.join(input.directory, "runtime", `host-${day}-${this.#pid}.jsonl`)
      : null;
  }

  isEnabled(level: DiagnosticLogLevel): boolean {
    return LEVEL_RANK[level] <= this.#level;
  }

  runtime(level: DiagnosticLogLevel, event: string, fields: DiagnosticLogFields = {}): void {
    if (!this.#runtimeFile || !this.isEnabled(level)) return;
    this.#files.append(this.#runtimeFile, this.#line(level, event, {}, fields));
  }

  thread(hostThreadId: string, harnessId: string): ThreadEventLog {
    let log = this.#threads.get(hostThreadId);
    if (!log) {
      log = new ThreadEventLog((level, event, fields) =>
        this.#writeThread(hostThreadId, harnessId, level, event, fields),
      );
      this.#threads.set(hostThreadId, log);
    }
    return log;
  }

  knownThread(hostThreadId: string): ThreadEventLog | undefined {
    return this.#threads.get(hostThreadId);
  }

  forgetThread(hostThreadId: string): void {
    this.#threads.delete(hostThreadId);
  }

  flush(): Promise<void> {
    return this.#files.flush();
  }

  #writeThread(
    hostThreadId: string,
    harnessId: string,
    level: DiagnosticLogLevel,
    event: string,
    fields: DiagnosticLogFields = {},
  ): void {
    if (!this.directory || !this.isEnabled(level)) return;
    const context = { hostThreadId, harnessId };
    if (!SAFE_FILE_ID.test(hostThreadId)) {
      // Never derive a path from an unexpected identity; keep the record process-scoped.
      this.#files.append(this.#runtimeFile ?? "", this.#line(level, event, context, fields));
      return;
    }
    this.#files.append(
      path.join(this.directory, "threads", `${hostThreadId}.jsonl`),
      this.#line(level, event, context, fields),
    );
  }

  #line(
    level: DiagnosticLogLevel,
    event: string,
    context: DiagnosticLogFields,
    fields: DiagnosticLogFields,
  ): string {
    return `${formatDiagnosticRecord({
      ts: this.#now(),
      level,
      event,
      pid: this.#pid,
      context,
      fields,
    })}\n`;
  }
}

/**
 * Omits free-form error text before persistence, then bounds and redacts the remaining metadata.
 * This applies to Thread and runtime records at every log level, including nested error fields.
 */
export function formatDiagnosticRecord(input: {
  ts: Date;
  level: DiagnosticLogLevel;
  event: string;
  pid: number;
  context?: DiagnosticLogFields;
  fields?: DiagnosticLogFields;
}): string {
  const head = {
    ts: input.ts.toISOString(),
    level: input.level,
    event: input.event,
    pid: input.pid,
    ...sanitizeFields(input.context ?? {}),
  };
  const record = JSON.stringify({ ...head, ...sanitizeFields(input.fields ?? {}) });
  return Buffer.byteLength(record, "utf8") <= RECORD_MAX_BYTES
    ? record
    : JSON.stringify({ ...head, truncated: true });
}

function sanitizeFields(fields: DiagnosticLogFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, value]) => {
      const sanitized = sanitizeValue(key, value, 0);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }),
  );
}

function sanitizeValue(key: string, value: DiagnosticLogValue, depth: number): unknown {
  if (value === undefined || CONTENT_KEYS.has(key)) return undefined;
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;
  if (depth >= VALUE_MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, COLLECTION_MAX_ENTRIES)
      .map((entry: DiagnosticLogValue) => sanitizeValue(key, entry, depth + 1) ?? null);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, DiagnosticLogValue>)
      .slice(0, COLLECTION_MAX_ENTRIES)
      .flatMap(([entryKey, entry]) => {
        const sanitized = sanitizeValue(entryKey, entry, depth + 1);
        return sanitized === undefined ? [] : [[entryKey, sanitized]];
      }),
  );
}

const homeDirectoryPatterns = (() => {
  const home = os.homedir();
  if (!home || home.length < 2) return [];
  const variants = new Set([home, home.replaceAll("\\", "/")]);
  const flags = process.platform === "win32" ? "giu" : "gu";
  return [...variants].map(
    (variant) => new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), flags),
  );
})();

function sanitizeText(value: string): string {
  const limit = STRING_MAX_CHARS;
  // Bound before redaction so a huge value cannot make regex work unbounded.
  const bounded = value.slice(0, limit * 2);
  let text = sanitizeDiagnosticTail(bounded);
  for (const pattern of homeDirectoryPatterns) text = text.replace(pattern, "~");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}[truncated ${text.length - limit} chars]`;
}

/** Serializes appends per file and rotates a full file once to `<name>.1.jsonl`. */
class LogFileAppender {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #sizes = new Map<string, number>();
  readonly #directories = new Set<string>();

  constructor(private readonly maxBytes: number) {}

  append(filePath: string, line: string): void {
    if (!filePath) return;
    const next = (this.#tails.get(filePath) ?? Promise.resolve())
      .then(() => this.#write(filePath, line))
      // Logging is best-effort and must never affect Host behavior.
      .catch(() => undefined);
    this.#tails.set(filePath, next);
    void next.then(() => {
      if (this.#tails.get(filePath) === next) this.#tails.delete(filePath);
    });
  }

  async flush(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()]);
  }

  async #write(filePath: string, line: string): Promise<void> {
    const directory = path.dirname(filePath);
    if (!this.#directories.has(directory)) {
      await mkdir(directory, { recursive: true });
      this.#directories.add(directory);
    }
    const bytes = Buffer.byteLength(line, "utf8");
    let size =
      this.#sizes.get(filePath) ??
      (await stat(filePath).then(
        (stats) => stats.size,
        () => 0,
      ));
    if (size > 0 && size + bytes > this.maxBytes) {
      await rename(filePath, rotatedLogPath(filePath)).catch(() => undefined);
      size = 0;
    }
    this.#sizes.set(filePath, size + bytes);
    await appendFile(filePath, line, "utf8");
  }
}

export function rotatedLogPath(filePath: string): string {
  return filePath.replace(/\.jsonl$/u, ".1.jsonl");
}
