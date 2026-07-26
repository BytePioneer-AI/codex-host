import { describe, expect, it } from "vitest";

import {
  jsonArraySchema,
  jsonObjectSchema,
  jsonPrimitiveSchema,
  jsonValueSchema,
} from "../src/index.js";

describe("JSON value contracts", () => {
  it("accepts nested JSON and preserves a JSON round-trip", () => {
    const input = {
      text: "value",
      count: 3.5,
      enabled: true,
      empty: null,
      nested: [1, { child: "ok" }, false],
    };

    const parsed = jsonValueSchema.parse(input);

    expect(parsed).toEqual(input);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    expect(jsonPrimitiveSchema.parse(null)).toBeNull();
    expect(jsonArraySchema.parse([1, "two"])).toEqual([1, "two"]);
    expect(jsonObjectSchema.parse({ answer: 42 })).toEqual({ answer: 42 });
  });

  it("returns validation failures for circular objects and arrays", () => {
    const cyclicObject: Record<string, unknown> = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);

    expect(jsonValueSchema.safeParse(cyclicObject).success).toBe(false);
    expect(jsonObjectSchema.safeParse(cyclicObject).success).toBe(false);
    expect(jsonValueSchema.safeParse(cyclicArray).success).toBe(false);
    expect(jsonArraySchema.safeParse(cyclicArray).success).toBe(false);
  });

  it("accepts repeated references that do not form a cycle", () => {
    const shared = { value: "shared" };
    const input = { left: shared, right: shared };

    expect(jsonValueSchema.parse(input)).toEqual(input);
  });

  it.each([
    undefined,
    1n,
    () => "not JSON",
    Symbol("not-json"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(0),
    new Map([["key", "value"]]),
    { nested: undefined },
  ])("rejects non-JSON runtime value %#", (value) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(false);
  });
});
