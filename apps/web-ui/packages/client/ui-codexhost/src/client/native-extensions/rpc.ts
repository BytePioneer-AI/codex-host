/**
 * Typed RPC client for the Web native extension runtime endpoints backed by the shared Host
 * channel (`POST api/ch/v1/rpc` -> `codexhost/extensions/*`).
 */
import {
  HOST_EXTENSIONS_RPC,
  hostExtensionsRpcSchemas,
  type HostExtensionManagementMethod,
  type HostExtensionSettings,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
  type HostExtensionsSnapshotResult,
  type JsonObject,
  type JsonValue,
} from "@codexhost/shared-contracts";

/** Structured RPC failure preserving the server's error code. */
export class WebExtensionRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebExtensionRpcError";
  }
}

async function callHostExtensionsRpc<M extends HostExtensionManagementMethod>(
  method: M,
  params: HostExtensionsRpcParams<M>,
  signal?: AbortSignal,
): Promise<HostExtensionsRpcResult<M>> {
  const schema = hostExtensionsRpcSchemas[method];
  const validatedParams = schema.params.parse(params);
  const response = await fetch("api/ch/v1/rpc", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: validatedParams }),
    ...(signal === undefined ? {} : { signal }),
  });

  let reply:
    | {
        result?: unknown;
        error?: { code?: number | string; message?: string };
      }
    | undefined;
  try {
    reply = (await response.json()) as typeof reply;
  } catch {
    if (!response.ok)
      throw new WebExtensionRpcError(
        `HTTP ${String(response.status)}`,
        response.status,
        response.status,
      );
    throw new Error(`Invalid RPC response for ${method}`);
  }
  if (reply?.error) {
    throw new WebExtensionRpcError(
      reply.error.message ?? `HTTP ${String(response.status)}`,
      reply.error.code ?? response.status,
      response.status,
    );
  }
  if (!response.ok) {
    throw new WebExtensionRpcError(
      `HTTP ${String(response.status)}`,
      response.status,
      response.status,
    );
  }
  return schema.result.parse(reply?.result) as HostExtensionsRpcResult<M>;
}

/** Transport surface injected into the Web native extension host (replaceable in tests). */
export interface WebNativeExtensionRpcClient {
  snapshot(signal?: AbortSignal): Promise<HostExtensionsSnapshotResult>;
  settingsGet(
    id: string,
    activationId: string,
    signal?: AbortSignal,
  ): Promise<HostExtensionSettings>;
  settingsSet(
    id: string,
    activationId: string,
    expectedSettingsRevision: number,
    values: JsonObject,
    signal?: AbortSignal,
  ): Promise<HostExtensionSettings>;
  backendInvoke(
    id: string,
    activationId: string,
    method: string,
    params?: JsonValue,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
}

/** Default same-origin RPC client backed by `HOST_EXTENSIONS_RPC` on `POST api/ch/v1/rpc`. */
export const webNativeExtensionRpcClient: WebNativeExtensionRpcClient = {
  snapshot: (signal) => callHostExtensionsRpc(HOST_EXTENSIONS_RPC.snapshot, {}, signal),
  settingsGet: (id, activationId, signal) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.settingsGet, { id, activationId }, signal),
  settingsSet: (id, activationId, expectedSettingsRevision, values, signal) =>
    callHostExtensionsRpc(
      HOST_EXTENSIONS_RPC.settingsSet,
      { id, activationId, expectedSettingsRevision, values },
      signal,
    ),
  backendInvoke: async (id, activationId, method, params, signal) => {
    const reply = await callHostExtensionsRpc(
      HOST_EXTENSIONS_RPC.backendInvoke,
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
