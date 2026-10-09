/** Fail a fixture lookup at its assertion site instead of asserting away absence. */
import assert from "node:assert/strict";

/**
 * Require a value supplied by a test fixture.
 * @param value Fixture element or lookup result.
 * @returns The non-null fixture value.
 */
export function defined<T>(value: T): NonNullable<T> {
  assert.notEqual(value, undefined);
  assert.notEqual(value, null);
  return value as NonNullable<T>;
}
