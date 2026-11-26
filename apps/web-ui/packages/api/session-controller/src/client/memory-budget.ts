/** Lightweight, allocation-free byte-size estimators for client session caches. */
import type { SessionJournalCache, SessionViewData } from "./sessions/recent-views.ts";

/** Conservative JS heap shell overhead per object or Map entry. */
const OBJECT_OVERHEAD_BYTES = 64;
const PRIMITIVE_BYTES = 8;
const POINTER_BYTES = 8;
const MAX_WALK_DEPTH = 12;

/** Memoized sizes for immutable wire records, event entries, and frozen snapshots. */
const immutableObjectBytes = new WeakMap<object, number>();

/** Approximate UTF-16 string memory footprint in bytes. */
export function estimateStringBytes(value: string): number {
  return value.length * 2;
}

/** Approximate in-memory size of one `ToolOutputCache` key/value entry. */
export function estimateToolOutputEntryBytes(key: string, value: string): number {
  return estimateStringBytes(key) + estimateStringBytes(value) + OBJECT_OVERHEAD_BYTES;
}

/** Approximate in-memory size of a string-keyed tool-output map. */
export function estimateToolOutputMapBytes(
  values: ReadonlyMap<string, string> | undefined,
): number {
  if (values === undefined || values.size === 0) return 0;
  let total = OBJECT_OVERHEAD_BYTES;
  for (const [key, value] of values) {
    total += estimateToolOutputEntryBytes(key, value);
  }
  return total;
}

/**
 * Recursively estimate the JS heap footprint of an arbitrary value without
 * `JSON.stringify` allocations. Frozen objects are memoized in a WeakMap.
 */
export function estimateUnknownBytes(value: unknown, depth = 0, active?: Set<object>): number {
  if (value === null || value === undefined) return 0;
  switch (typeof value) {
    case "string":
      return estimateStringBytes(value);
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return PRIMITIVE_BYTES;
    case "function":
      return OBJECT_OVERHEAD_BYTES;
    case "object": {
      if (depth >= MAX_WALK_DEPTH) return OBJECT_OVERHEAD_BYTES;
      if (ArrayBuffer.isView(value)) return value.byteLength + OBJECT_OVERHEAD_BYTES;
      if (value instanceof ArrayBuffer) return value.byteLength + OBJECT_OVERHEAD_BYTES;
      const cached = immutableObjectBytes.get(value);
      if (cached !== undefined) return cached;
      if (active?.has(value)) return POINTER_BYTES;
      const visited = active ?? new Set<object>();
      visited.add(value);
      let total = OBJECT_OVERHEAD_BYTES;
      try {
        if (Array.isArray(value)) {
          total += value.length * POINTER_BYTES;
          for (let i = 0; i < value.length; i += 1) {
            total += estimateUnknownBytes(value[i], depth + 1, visited);
          }
        } else if (value instanceof Map) {
          for (const [entryKey, entryValue] of value) {
            total +=
              OBJECT_OVERHEAD_BYTES +
              estimateUnknownBytes(entryKey, depth + 1, visited) +
              estimateUnknownBytes(entryValue, depth + 1, visited);
          }
        } else if (value instanceof Set) {
          for (const item of value) {
            total += POINTER_BYTES + estimateUnknownBytes(item, depth + 1, visited);
          }
        } else {
          const record = value as Record<string, unknown>;
          for (const key in record) {
            if (!Object.hasOwn(record, key)) continue;
            total +=
              estimateStringBytes(key) +
              POINTER_BYTES +
              estimateUnknownBytes(record[key], depth + 1, visited);
          }
        }
      } finally {
        visited.delete(value);
      }
      if (depth === 0 && active === undefined && Object.isFrozen(value)) {
        immutableObjectBytes.set(value, total);
      }
      return total;
    }
    default:
      return 0;
  }
}

/** Memoized byte estimate for one immutable wire history record or event entry. */
export function estimateEventEntryBytes(entry: object): number {
  const cached = immutableObjectBytes.get(entry);
  if (cached !== undefined) return cached;
  const bytes = estimateUnknownBytes(entry);
  immutableObjectBytes.set(entry, bytes);
  return bytes;
}

/** Incremental byte contribution of a batch of event entries in a window. */
export function estimateEventEntriesBytes(entries: readonly object[]): number {
  let total = 0;
  for (let i = 0; i < entries.length; i += 1) {
    total += POINTER_BYTES + estimateEventEntryBytes(entries[i]!);
  }
  return total;
}

/** Approximate in-memory footprint of a captured durable journal window. */
export function estimateJournalBytes(journal: SessionJournalCache | undefined): number {
  if (journal === undefined) return 0;
  return (
    OBJECT_OVERHEAD_BYTES +
    estimateStringBytes(journal.epoch) +
    estimateEventEntriesBytes(journal.records)
  );
}

/**
 * Approximate in-memory footprint of one detached `SessionViewData`.
 * Deduplicates shared record/event references between `journal.records` and `entries`.
 */
export function estimateSessionViewBytes(view: SessionViewData): number {
  let total = OBJECT_OVERHEAD_BYTES;
  let counted: Set<object> | undefined;
  if (view.journal !== undefined) {
    total += OBJECT_OVERHEAD_BYTES + estimateStringBytes(view.journal.epoch);
    counted = new Set<object>();
    for (const record of view.journal.records) {
      total += POINTER_BYTES + estimateEventEntryBytes(record);
      counted.add(record);
      if (typeof record.event === "object" && record.event !== null) {
        counted.add(record.event);
      }
    }
  }
  total += OBJECT_OVERHEAD_BYTES;
  for (const entry of view.entries) {
    total += POINTER_BYTES;
    if (counted !== undefined) {
      if (counted.has(entry)) continue;
      if (typeof entry.event === "object" && entry.event !== null && counted.has(entry.event)) {
        total += OBJECT_OVERHEAD_BYTES;
        continue;
      }
    }
    total += estimateEventEntryBytes(entry);
  }
  total += estimateToolOutputMapBytes(view.toolOutputs);
  total += estimateUnknownBytes(view.projections);
  return total;
}
