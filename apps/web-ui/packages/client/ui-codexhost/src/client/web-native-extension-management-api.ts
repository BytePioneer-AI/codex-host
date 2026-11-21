/**
 * Unified Host Extensions RPC & ZIP upload client for the Web Plugins center.
 *
 * All management calls go through `POST api/ch/v1/rpc` (`codexhost/extensions/*`);
 * ZIP installs/updates stream binary ZIP payloads to `POST api/extensions/upload`.
 */
import {
  HOST_EXTENSIONS_RPC,
  HOST_EXTENSION_UPLOAD_PATH,
  hostExtensionsRpcSchemas,
  type HostExtensionManagementMethod,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
} from "@codexhost/shared-contracts";

/** Structured error from the Host client channel RPC or upload endpoint. */
export class HostExtensionRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HostExtensionRpcError";
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

  const payload = (await response.json().catch(() => undefined)) as
    { result?: unknown; error?: { code?: number | string; message?: string } } | undefined;

  if (payload?.error) {
    throw new HostExtensionRpcError(
      payload.error.message ?? `HTTP ${String(response.status)}`,
      payload.error.code ?? response.status,
      response.status,
    );
  }
  if (!response.ok) {
    throw new HostExtensionRpcError(
      `HTTP ${String(response.status)}`,
      response.status,
      response.status,
    );
  }
  return schema.result.parse(payload?.result) as HostExtensionsRpcResult<M>;
}

const UPLOAD_BASE_URL = HOST_EXTENSION_UPLOAD_PATH.replace(/^\/+/u, "");

interface UploadZipOptions {
  readonly id?: string | undefined;
  readonly expectedDigest?: string | undefined;
  readonly expectedActivationId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

async function uploadHostExtensionZip(
  file: Blob,
  options: UploadZipOptions = {},
): Promise<HostExtensionsRpcResult<typeof HOST_EXTENSIONS_RPC.install>> {
  const query = new URLSearchParams();
  if (options.id) query.set("id", options.id);
  if (options.expectedDigest) query.set("expectedDigest", options.expectedDigest);
  if (options.expectedActivationId) {
    query.set("expectedActivationId", options.expectedActivationId);
  }
  const suffix = query.toString();
  const url = suffix ? `${UPLOAD_BASE_URL}?${suffix}` : UPLOAD_BASE_URL;

  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/zip" },
    body: file,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const payload = (await response.json().catch(() => undefined)) as
    | {
        result?: unknown;
        error?: string | { code?: number | string; message?: string };
        message?: string;
        code?: number | string;
      }
    | undefined;

  if (!response.ok) {
    if (payload && typeof payload.error === "object" && payload.error !== null) {
      throw new HostExtensionRpcError(
        payload.error.message ?? `HTTP ${String(response.status)}`,
        payload.error.code ?? response.status,
        response.status,
      );
    }
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : `HTTP ${String(response.status)}`;
    throw new HostExtensionRpcError(message, payload?.code ?? response.status, response.status);
  }

  return hostExtensionsRpcSchemas[HOST_EXTENSIONS_RPC.install].result.parse(payload?.result);
}

export function isHostExtensionAuthDisabledError(error: unknown): boolean {
  if (!(error instanceof HostExtensionRpcError)) return false;
  if (error.status === 403) return true;
  return /authentication must be enabled|auth.*disabled/iu.test(error.message);
}

export function isHostExtensionUnavailableError(error: unknown): boolean {
  if (!(error instanceof HostExtensionRpcError)) return false;
  return error.code === -32601 || error.status === 503;
}

export function isHostExtensionRevisionConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /revision|conflict|stale/iu.test(message);
}

export const hostExtensionsApi = {
  list: (signal?: AbortSignal) => callHostExtensionsRpc(HOST_EXTENSIONS_RPC.list, {}, signal),

  snapshot: (signal?: AbortSignal) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.snapshot, {}, signal),

  catalog: (
    params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.catalog> = {},
    signal?: AbortSignal,
  ) => callHostExtensionsRpc(HOST_EXTENSIONS_RPC.catalog, params, signal),

  install: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.install>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.install, params),

  update: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.update>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.update, params),

  enable: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.enable>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.enable, params),

  disable: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.disable>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.disable, params),

  uninstall: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.uninstall>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.uninstall, params),

  recover: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.recover> = {}) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.recover, params),

  settingsGet: (
    params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.settingsGet>,
    signal?: AbortSignal,
  ) => callHostExtensionsRpc(HOST_EXTENSIONS_RPC.settingsGet, params, signal),

  settingsSet: (params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.settingsSet>) =>
    callHostExtensionsRpc(HOST_EXTENSIONS_RPC.settingsSet, params),

  backendInvoke: (
    params: HostExtensionsRpcParams<typeof HOST_EXTENSIONS_RPC.backendInvoke>,
    signal?: AbortSignal,
  ) => callHostExtensionsRpc(HOST_EXTENSIONS_RPC.backendInvoke, params, signal),

  uploadZip: (file: Blob, options?: UploadZipOptions) => uploadHostExtensionZip(file, options),
};
