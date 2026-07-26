import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export const jsonPrimitiveSchema: z.ZodType<JsonPrimitive> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

function hasNoCircularReferences(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const stack: Array<{ value: unknown; leaving: boolean }> = [{ value, leaving: false }];

  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;

      if (frame.leaving) {
        ancestors.delete(frame.value as object);
        continue;
      }

      if (typeof frame.value !== "object" || frame.value === null) continue;
      if (ancestors.has(frame.value)) return false;

      ancestors.add(frame.value);
      stack.push({ value: frame.value, leaving: true });
      for (const child of Object.values(frame.value)) {
        stack.push({ value: child, leaving: false });
      }
    }
  } catch {
    return false;
  }

  return true;
}

const nonCircularSchema = z.custom<unknown>(hasNoCircularReferences, {
  message: "JSON value must not contain circular references",
});

const recursiveJsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(recursiveJsonValueSchema),
    z.record(z.string(), recursiveJsonValueSchema),
  ]),
);

export const jsonValueSchema: z.ZodType<JsonValue> =
  nonCircularSchema.pipe(recursiveJsonValueSchema);
export const jsonArraySchema: z.ZodType<JsonArray> = nonCircularSchema.pipe(
  z.array(recursiveJsonValueSchema),
);
export const jsonObjectSchema: z.ZodType<JsonObject> = nonCircularSchema.pipe(
  z.record(z.string(), recursiveJsonValueSchema),
);
