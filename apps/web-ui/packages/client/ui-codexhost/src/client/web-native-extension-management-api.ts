/** Management RPC and binary ZIP upload client for Web native & DSH extensions. */
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
import {
  WEB_EXTENSION_RPC_ERRORS,
  WEB_EXTENSION_UPLOAD_PATH,
  WEB_EXTENSIONS_RPC,
  webExtensionZipUploadResultSchema,
  webExtensionsRpcSchemas,
  type WebExtensionZipUploadResult,
  type WebExtensionsRpcMethod,
  type WebExtensionsRpcParams,
  type WebExtensionsRpcResult,
} from "@codexhost/shared-contracts";
import { ApiError } from "./api.ts";

interface RpcEnvelope {
  result?:
    | { ok: true; value: unknown }
    | { ok: false; error: { message: string; code: string; details?: unknown } };
}

async function callWebExtensionsRpc<M extends WebExtensionsRpcMethod>(
  method: M,
  params: WebExtensionsRpcParams<M>,
  signal?: AbortSignal,
): Promise<WebExtensionsRpcResult<M>> {
  const validatedParams = webExtensionsRpcSchemas[method].params.parse(params);
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method,
      payload: { args: validatedParams },
    }),
    signal,
  });
  const envelope = (await response.json().catch(() => undefined)) as RpcEnvelope | undefined;
  if (envelope?.result?.ok === false) {
    const { message, code, details } = envelope.result.error;
    throw new ApiError(message, code, details);
  }
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  if (envelope?.result?.ok !== true) throw new Error("Invalid extension RPC response");
  return webExtensionsRpcSchemas[method].result.parse(
    envelope.result.value,
  ) as WebExtensionsRpcResult<M>;
}

const UPLOAD_URL = WEB_EXTENSION_UPLOAD_PATH.replace(/^\/+/u, "");

interface UploadErrorPayload {
  error?: string | { message?: unknown; code?: unknown; details?: unknown };
  message?: unknown;
  code?: unknown;
}

async function uploadWebExtensionZip(
  file: Blob,
  signal?: AbortSignal,
): Promise<WebExtensionZipUploadResult> {
  const response = await fetch(UPLOAD_URL, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/zip" },
    body: file,
    signal,
  });
  const payload = (await response.json().catch(() => undefined)) as UploadErrorPayload | undefined;
  if (!response.ok) {
    if (payload && typeof payload.error === "object" && payload.error !== null) {
      const code =
        typeof payload.error.code === "string"
          ? payload.error.code
          : WEB_EXTENSION_RPC_ERRORS.changeFailed;
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : `HTTP ${String(response.status)}`;
      throw new ApiError(message, code, payload.error.details);
    }
    if (typeof payload?.code === "string" && typeof payload.message === "string") {
      throw new ApiError(payload.message, payload.code, undefined);
    }
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : `HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  return webExtensionZipUploadResultSchema.parse(payload);
}

export function isWebExtensionAuthDisabledError(error: unknown): boolean {
  return error instanceof ApiError && error.code === WEB_EXTENSION_RPC_ERRORS.authDisabled;
}

export function isWebExtensionStaleError(error: unknown): boolean {
  return error instanceof ApiError && error.code === WEB_EXTENSION_RPC_ERRORS.stale;
}

export function isWebExtensionMarketUnavailableError(error: unknown): boolean {
  return error instanceof ApiError && error.code === WEB_EXTENSION_RPC_ERRORS.marketUnavailable;
}

export const webNativeExtensionsApi = {
  list: (signal?: AbortSignal) => callWebExtensionsRpc(WEB_EXTENSIONS_RPC.list, {}, signal),

  install: (params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.install>) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.install, params),

  update: (params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.update>) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.update, params),

  setEnabled: (params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.setEnabled>) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.setEnabled, params),

  uninstall: (params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.uninstall>) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.uninstall, params),

  settingsGet: (
    params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.settingsGet>,
    signal?: AbortSignal,
  ) => callWebExtensionsRpc(WEB_EXTENSIONS_RPC.settingsGet, params, signal),

  settingsSet: (params: WebExtensionsRpcParams<typeof WEB_EXTENSIONS_RPC.settingsSet>) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.settingsSet, params),

  marketRefresh: (signal?: AbortSignal) =>
    callWebExtensionsRpc(WEB_EXTENSIONS_RPC.marketRefresh, {}, signal),

  uploadZip: (file: Blob, signal?: AbortSignal) => uploadWebExtensionZip(file, signal),

  installNativeZip: async (file: Blob, signal?: AbortSignal) => {
    const { uploadId } = await uploadWebExtensionZip(file, signal);
    return callWebExtensionsRpc(
      WEB_EXTENSIONS_RPC.install,
      { format: "codexhost", source: { type: "zip", uploadId } },
      signal,
    );
  },

  updateNativeZip: async (id: string, expectedDigest: string, file: Blob, signal?: AbortSignal) => {
    const { uploadId } = await uploadWebExtensionZip(file, signal);
    return callWebExtensionsRpc(
      WEB_EXTENSIONS_RPC.update,
      { format: "codexhost", id, expectedDigest, source: { type: "zip", uploadId } },
      signal,
    );
  },
};
