import { z } from "zod";

import { harnessIdSchema } from "./ids.js";
import { jsonValueSchema, rejectExplicitUndefined } from "./json-value.js";
import type { JsonValue } from "./json-value.js";

const nativeIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Native identifier must not be empty or whitespace",
});

export const nativeSessionRefV1Schema = z
  .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeIdSchema,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
  })
  .superRefine(rejectExplicitUndefined(["locator"]));
export type NativeSessionRefV1 = Omit<z.infer<typeof nativeSessionRefV1Schema>, "locator"> & {
  locator?: JsonValue;
};
export const nativeSessionRefSchema = nativeSessionRefV1Schema;
export type NativeSessionRef = NativeSessionRefV1;

export const nativeTurnRefV1Schema = z.strictObject({
  harnessId: harnessIdSchema,
  nativeSessionId: nativeIdSchema,
  nativeTurnKey: nativeIdSchema,
  formatVersion: z.literal(1),
});
export type NativeTurnRefV1 = z.infer<typeof nativeTurnRefV1Schema>;
export const nativeTurnRefSchema = nativeTurnRefV1Schema;
export type NativeTurnRef = NativeTurnRefV1;

export const nativeCheckpointRefV1Schema = z
  .strictObject({
    harnessId: harnessIdSchema,
    nativeSessionId: nativeIdSchema,
    checkpointId: nativeIdSchema,
    locator: jsonValueSchema.optional(),
    formatVersion: z.literal(1),
  })
  .superRefine(rejectExplicitUndefined(["locator"]));
export type NativeCheckpointRefV1 = Omit<z.infer<typeof nativeCheckpointRefV1Schema>, "locator"> & {
  locator?: JsonValue;
};
export const nativeCheckpointRefSchema = nativeCheckpointRefV1Schema;
export type NativeCheckpointRef = NativeCheckpointRefV1;
