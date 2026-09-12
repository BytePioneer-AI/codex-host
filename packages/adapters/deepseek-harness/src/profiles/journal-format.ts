import { redactModernCredential } from "../modern/wire.js";
import type {
  ModernJournalEvent,
  ModernJournalJson,
  ModernJournalSurfaceOp,
} from "../modern/journal.js";
const MODERN_JOURNAL_MAX_JSON_DEPTH = 100;
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

export function parseEvent(value: unknown, format: 0 | 3 = 0): ModernJournalEvent {
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
  if (format === 3 && value.ignorable === true) {
    // Vocabulary-aware validation decides whether these fields have surface semantics.
    if (Object.hasOwn(value, "sourceEventSeqs"))
      assertJsonValue(value.sourceEventSeqs, "journal event sourceEventSeqs");
    if (Object.hasOwn(value, "surfaceOp"))
      assertJsonValue(value.surfaceOp, "journal event surfaceOp");
    return value as unknown as ModernJournalEvent;
  }
  if (Object.hasOwn(value, "sourceEventSeqs")) {
    if (
      !Array.isArray(value.sourceEventSeqs) ||
      value.sourceEventSeqs.some((seq) => !isSeq(seq) || seq >= (value.seq as number)) ||
      new Set(value.sourceEventSeqs).size !== value.sourceEventSeqs.length
    ) {
      throw protocolError("journal event has invalid sourceEventSeqs");
    }
  }
  if (Object.hasOwn(value, "surfaceOp")) parseSurfaceOp(value.surfaceOp, format);
  return value as unknown as ModernJournalEvent;
}

function parseSurfaceOp(value: unknown, format: 0 | 3): ModernJournalSurfaceOp {
  if (value === "append") return value;
  const start = format === 3 ? "startSeq" : "start";
  const end = format === 3 ? "endSeq" : "end";
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["op", start, end]) ||
    value.op !== "replace" ||
    !isSeq(value[start]) ||
    !isSeq(value[end])
  ) {
    throw protocolError("journal event has an invalid surfaceOp");
  }
  return value as unknown as ModernJournalSurfaceOp;
}

export function assertJsonValue(value: unknown, label: string): asserts value is ModernJournalJson {
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

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function hasRequiredOptionalKeys(
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

export function isSeq(value: unknown): value is number {
  return isNonNegativeSafeInteger(value);
}

export function isCursor(value: unknown): value is number {
  return value === -1 || isSeq(value);
}

export function protocolError(message: string): ModernJournalError {
  return new ModernJournalError("protocolError", message);
}

export function limitError(message: string): ModernJournalError {
  return new ModernJournalError("limitExceeded", message);
}
