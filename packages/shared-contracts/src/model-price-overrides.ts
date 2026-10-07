import { z } from "zod";

/**
 * Custom model prices in the Host's `pricing.json`. They only change the Host's API-equivalent
 * usage estimate; they never register a Model or Provider, or change accounts or billing.
 */
export const MODEL_PRICE_OVERRIDES_GET_METHOD = "codexhost/usage/model-prices/get";
export const MODEL_PRICE_OVERRIDES_SET_METHOD = "codexhost/usage/model-prices/set";
/** The price the Host would use without custom prices, as a starting point for an override. */
export const MODEL_PRICE_DEFAULT_METHOD = "codexhost/usage/model-prices/default";

const usdPerMillionTokens = z.number().finite().nonnegative();

/** USD per million Tokens. Each override replaces the whole default price for its key. */
export const modelPriceOverrideSchema = z.strictObject({
  input: usdPerMillionTokens,
  output: usdPerMillionTokens,
  cacheRead: usdPerMillionTokens.optional(),
  cacheWrite: usdPerMillionTokens.optional(),
  cacheWrite1h: usdPerMillionTokens.optional(),
});

/** A model ID, matched exactly as written. */
export const modelPriceKeySchema = z
  .string()
  .max(512)
  .refine((key) => key.trim() === key && key.length > 0, "Model ID is required");

export const modelPriceOverridesSchema = z.strictObject({
  /** Absolute path of the Host's `pricing.json`. */
  path: z.string(),
  entries: z.array(z.strictObject({ key: z.string(), price: modelPriceOverrideSchema })),
  /** Why the existing file is unusable; the Host then ignores it and refuses to overwrite it. */
  error: z.string().nullable(),
});

export const modelPriceOverridesGetSchema = z.strictObject({});

/**
 * Changes one key and keeps every other entry. Without `previousKey` this adds a key that must
 * not exist yet; with it, the entry `previousKey` is replaced (or renamed to `key`). A null
 * price removes `key`, restoring the default lookup.
 */
export const modelPriceOverridesSetSchema = z.strictObject({
  key: modelPriceKeySchema,
  price: modelPriceOverrideSchema.nullable(),
  previousKey: modelPriceKeySchema.optional(),
});

export const modelPriceDefaultParamsSchema = z.strictObject({
  model: modelPriceKeySchema,
});

export const modelPriceDefaultResultSchema = z.strictObject({
  price: modelPriceOverrideSchema.nullable(),
});

export type ModelPriceOverride = z.infer<typeof modelPriceOverrideSchema>;
export type ModelPriceOverrides = z.infer<typeof modelPriceOverridesSchema>;
export type ModelPriceOverridesSet = z.infer<typeof modelPriceOverridesSetSchema>;
export type ModelPriceDefaultParams = z.infer<typeof modelPriceDefaultParamsSchema>;
export type ModelPriceDefaultResult = z.infer<typeof modelPriceDefaultResultSchema>;
