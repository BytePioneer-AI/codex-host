/**
 * Typed RPC client for the Web native extension runtime endpoints.
 * Uses the same `POST api/<method>` client-request envelope as the rest of Web UI.
 */
import {
  WEB_EXTENSIONS_RPC,
  webExtensionsRpcSchemas,
  type JsonObject,
  type JsonValue,
  type WebExtensionRuntimeSnapshot,
  type WebExtensionsRpcMethod,
  type WebExtensionsRpcParams,
  type WebExtensionsRpcResult,
} from "@codexhost/shared-contracts";

/** Structured RPC failure preserving the server's error code. */
export class WebExtensionRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WebExtensionRpcError";
  }
}

function createRpcId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `web-ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function callWebExtensionsRpc<M extends WebExtensionsRpcMethod>(
  method: M,
  params: WebExtensionsRpcParams<M>,
  signal?: AbortSignal,
): Promise<WebExtensionsRpcResult<M>> {
  const schema = webExtensionsRpcSchemas[method];
  const args = schema.params.parse(params);
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: createRpcId(),
      method,
      payload: { args },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  let envelope:
    | {
        result?:
          | { ok: true; value: unknown }
          | { ok: false; error: { message: string; code: string; details?: unknown } };
      }
    | undefined;
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    throw new Error(`Invalid RPC response for ${method}`);
  }
  if (envelope?.result?.ok === false) {
    const { message, code, details } = envelope.result.error;
    throw new WebExtensionRpcError(message, code, details);
  }
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  if (envelope?.result?.ok !== true) {
    throw new Error(`Missing RPC result for ${method}`);
  }
  return schema.result.parse(envelope.result.value) as WebExtensionsRpcResult<M>;
}

/** Transport surface injected into the Web native extension host (replaceable in tests). */
export interface WebNativeExtensionRpcClient {
  snapshot(signal?: AbortSignal): Promise<WebExtensionRuntimeSnapshot>;
  settingsGet(
    id: string,
    activationId: string,
    signal?: AbortSignal,
  ): Promise<{ values: JsonObject; revision: string }>;
  settingsSet(
    id: string,
    activationId: string,
    values: JsonObject,
    signal?: AbortSignal,
  ): Promise<{ values: JsonObject; revision: string }>;
  backendInvoke(
    id: string,
    activationId: string,
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
}

/** Default same-origin RPC client backed by `WEB_EXTENSIONS_RPC`. */
export const webNativeExtensionRpcClient: WebNativeExtensionRpcClient = {
  snapshot: (signal) => callWebExtensionsRpc(WEB_EXTENSIONS_RPC.snapshot, {}, signal),
  settingsGet: (id, activationId, signal) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.settingsGet, { id, activationId }, signal),
  settingsSet: (id, activationId, values, signal) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.settingsSet, { id, activationId, values }, signal),
  backendInvoke: async (id, activationId, method, params, signal) => {
    const reply = await callWebExtensionsRpc(
      WEB_EXTENSIONS_RPC.backendInvoke,
      {
        id,
        activationId,
        method,
        ...(params === undefined ? {} : { params }),
      },
      signal,
    );
    return reply.result;
  },
};
