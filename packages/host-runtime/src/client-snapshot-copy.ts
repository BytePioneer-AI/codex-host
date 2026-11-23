const notPlainJson = Symbol();

function copy(value: unknown): unknown {
  // Strings are immutable, so large command output is shared rather than re-encoded.
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value || 0 : null;
  if (typeof value !== "object" || "toJSON" in value) throw notPlainJson;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw notPlainJson;
    return Array.from(value, (entry) => (entry === undefined ? null : copy(entry)));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw notPlainJson;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined)
      Object.defineProperty(result, key, {
        value: copy(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}

/**
 * A detached copy with the result of a JSON round trip. Plain wire data is copied
 * directly; anything else goes through JSON.
 */
export function copyAsJson(value: unknown): unknown {
  try {
    return copy(value);
  } catch (error) {
    if (error !== notPlainJson) throw error;
    return JSON.parse(JSON.stringify(value));
  }
}
