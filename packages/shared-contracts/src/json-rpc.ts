import { z } from "zod";

import { jsonValueSchema } from "./json-value.js";

const jsonRpcVersionSchema = z.literal("2.0").optional();
const absentSchema = z.never().optional();
const methodSchema = z.string().min(1);

export const jsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

export const jsonRpcErrorSchema = z.looseObject({
  code: z.number().int(),
  message: z.string(),
  data: jsonValueSchema.optional(),
});
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

export const jsonRpcRequestSchema = z.looseObject({
  jsonrpc: jsonRpcVersionSchema,
  id: jsonRpcIdSchema,
  method: methodSchema,
  params: jsonValueSchema.optional(),
  result: absentSchema,
  error: absentSchema,
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export const jsonRpcNotificationSchema = z.looseObject({
  jsonrpc: jsonRpcVersionSchema,
  id: absentSchema,
  method: methodSchema,
  params: jsonValueSchema.optional(),
  result: absentSchema,
  error: absentSchema,
});
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

export const jsonRpcSuccessResponseSchema = z.looseObject({
  jsonrpc: jsonRpcVersionSchema,
  id: jsonRpcIdSchema,
  method: absentSchema,
  params: absentSchema,
  result: jsonValueSchema,
  error: absentSchema,
});
export type JsonRpcSuccessResponse = z.infer<typeof jsonRpcSuccessResponseSchema>;

export const jsonRpcErrorResponseSchema = z.looseObject({
  jsonrpc: jsonRpcVersionSchema,
  id: jsonRpcIdSchema,
  method: absentSchema,
  params: absentSchema,
  result: absentSchema,
  error: jsonRpcErrorSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;

export const jsonRpcEnvelopeSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);
export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
