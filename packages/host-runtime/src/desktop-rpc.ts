import type { JsonObject, JsonRpcRequest } from "@codexhost/protocol-core";

/** Desktop/console requests present Desktop surfaces; client-channel requests do not. */
export type HostRequestOrigin = "desktop" | "console" | "client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

export function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

/**
 * Reads routing fields before ownership is known. Never throws: a shape the Host does not
 * recognize belongs to native Codex, which validates its own protocol.
 */
export function routingParams(request: JsonRpcRequest): JsonObject {
  return isRecord(request.params) ? (request.params as JsonObject) : {};
}
