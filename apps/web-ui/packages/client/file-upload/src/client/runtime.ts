/** Background browser upload implementation for Blob and byte-stream bodies. */

import { Service, type Context } from "@deepseek-ai/cordis";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { FILE_UPLOAD_ROUTE } from "../protocol.ts";
import type { ClientFileUploadHooks, FileUploadFetch, FileUploadValue } from "../types.ts";
import type { FileUploadBody, FileUploadService } from "./contract.ts";

interface FileUploadRequest {
  /** Document-relative app-owned upload route, query string included. */
  readonly path: string;
  readonly body: FileUploadBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { readonly loaded: number; readonly total?: number }) => void;
}

interface FileUploadResponse {
  readonly status: number;
  readonly body: string;
}

interface UploadWorkerStart {
  readonly url: string;
  readonly body: FileUploadBody;
  readonly headers: Readonly<Record<string, string>>;
}

type UploadWorkerOutput =
  | { readonly kind: "progress"; readonly loaded: number; readonly total?: number }
  | { readonly kind: "complete"; readonly status: number; readonly body: string }
  | { readonly kind: "error"; readonly message: string };

interface UploadWorkerScope {
  onmessage: ((event: MessageEvent<UploadWorkerStart>) => void) | null;
  postMessage(message: UploadWorkerOutput): void;
}

interface UploadXhr {
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null };
  status: number;
  responseText: string;
  withCredentials: boolean;
  onload: ((event: ProgressEvent) => void) | null;
  onerror: ((event: ProgressEvent) => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
}

type UploadWorkerFetch = (
  input: string,
  init: RequestInit & { readonly duplex: "half" },
) => Promise<Response>;

/**
 * Self-contained Worker body; its string form becomes the Blob Worker source.
 * @param scope - Worker global used for requests and progress messages.
 * @param createXhr - XMLHttpRequest factory used for Blob progress.
 * @param doFetch - Fetch carrier used for one-shot ReadableStream bodies.
 */
export function fileUploadWorker(
  scope: UploadWorkerScope = self,
  createXhr: () => UploadXhr = () => new XMLHttpRequest(),
  doFetch: UploadWorkerFetch = (input, init) => fetch(input, init),
): void {
  scope.onmessage = (event: MessageEvent<UploadWorkerStart>) => {
    const request = event.data;
    let settled = false;
    let loaded = 0;
    let cancel = (): void => {};
    const finish = (output: UploadWorkerOutput, abort = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (abort) cancel();
      scope.postMessage(output);
    };
    const timeout = (): void => {
      finish({ kind: "error", message: "Upload made no progress for 60 seconds." }, true);
    };
    let deadline = setTimeout(timeout, 60_000);
    const progress = (bytes: number, total?: number): void => {
      if (settled) return;
      if (bytes > loaded) {
        loaded = bytes;
        clearTimeout(deadline);
        deadline = setTimeout(timeout, 60_000);
      }
      scope.postMessage({
        kind: "progress",
        loaded: bytes,
        ...(total === undefined ? {} : { total }),
      });
    };
    if (request.body instanceof Blob) {
      const xhr = createXhr();
      xhr.open("POST", request.url);
      xhr.withCredentials = true;
      for (const [name, value] of Object.entries(request.headers))
        xhr.setRequestHeader(name, value);
      cancel = () => xhr.abort();
      xhr.upload.onprogress = (event) => {
        progress(event.loaded, event.lengthComputable ? event.total : undefined);
      };
      xhr.onload = () => {
        finish({
          kind: "complete",
          status: xhr.status,
          body: xhr.responseText,
        } satisfies UploadWorkerOutput);
      };
      xhr.onerror = () => {
        finish({
          kind: "error",
          message: "background upload transport failed",
        } satisfies UploadWorkerOutput);
      };
      xhr.send(request.body);
      return;
    }
    if (!(request.body instanceof ReadableStream)) {
      finish({
        kind: "error",
        message: "background upload worker received an invalid body",
      });
      return;
    }
    const source = request.body;
    void (async () => {
      const reader = source.getReader();
      const controller = new AbortController();
      cancel = () => {
        controller.abort();
        void reader.cancel().catch(() => {});
      };
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const item = await reader.read();
          if (item.done) {
            controller.close();
            return;
          }
          if (!(item.value instanceof Uint8Array)) {
            throw new TypeError("background upload stream produced a non-Uint8Array chunk");
          }
          bytes += item.value.byteLength;
          progress(bytes);
          controller.enqueue(item.value);
        },
        async cancel(reason) {
          await reader.cancel(reason);
        },
      });
      const response = await doFetch(request.url, {
        method: "POST",
        headers: request.headers,
        credentials: "include",
        body,
        duplex: "half",
        signal: controller.signal,
      });
      finish({
        kind: "complete",
        status: response.status,
        body: await response.text(),
      });
    })().catch((error: unknown) => {
      finish({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}

interface ClientFileUploadGlobal {
  __DSH_FILE_UPLOAD__?: ClientFileUploadHooks;
}

interface FileUploadTransport {
  post(request: FileUploadRequest): Promise<FileUploadResponse>;
}

/** Cordis service that owns one background carrier per upload operation. */
export class FileUploadRuntime extends Service implements FileUploadService {
  private readonly transport: FileUploadTransport;

  /** @param ctx - providing Client context. */
  constructor(ctx: Context) {
    super(ctx, "fileUpload");
    const hook = (globalThis as ClientFileUploadGlobal).__DSH_FILE_UPLOAD__;
    this.transport = hook === undefined ? workerTransport() : customTransport(hook.fetch);
  }

  /**
   * Post one body with the carrier selected before Cordis boot.
   * @param request - target, body, cancellation, and progress observer.
   * @returns the response status and text body.
   */
  post(request: FileUploadRequest): Promise<FileUploadResponse> {
    return this.transport.post(request);
  }

  /**
   * Store one file for a Session.
   * @param sessionId - Session that owns the staged receipt.
   * @param data - browser Blob, exact bytes, or a one-shot byte stream.
   * @param name - optional display name.
   * @param signal - optional cancellation for the active upload.
   * @param onProgress - optional byte-progress observer for background bodies.
   * @returns the staged receipt and durable file reference, or a business error.
   */
  async upload(
    sessionId: SessionId,
    data: Blob | Uint8Array | ReadableStream<Uint8Array>,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: { readonly loaded: number; readonly total?: number }) => void,
    imageMediaType?: string,
  ): Promise<RemoteResult<FileUploadValue>> {
    const query = new URLSearchParams({ sessionId });
    if (name !== undefined) query.set("name", name);
    if (imageMediaType !== undefined) query.set("imageMediaType", imageMediaType);
    // All browser carriers use raw-byte intake, never the bounded JSON RPC route.
    const body = data instanceof Uint8Array ? new Blob([Uint8Array.from(data).buffer]) : data;
    const response = await this.post({
      path: `${FILE_UPLOAD_ROUTE}?${query.toString()}`,
      body,
      headers: { "content-type": "application/octet-stream" },
      ...(signal === undefined ? {} : { signal }),
      ...(onProgress === undefined ? {} : { onProgress }),
    });
    if (response.status !== 200) {
      throw new Error(`file upload transport failed with HTTP ${String(response.status)}`);
    }
    return parseFileUploadResult(response.body);
  }
}

function customTransport(customFetch: FileUploadFetch): FileUploadTransport {
  return {
    async post(request) {
      const init: RequestInit & { duplex?: "half" } = {
        method: "POST",
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        body: request.body,
        ...(request.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const response = await customFetch(request.path, init);
      return { status: response.status, body: await response.text() };
    },
  };
}

function workerTransport(): FileUploadTransport {
  return {
    post(request) {
      if (typeof Worker !== "function") {
        return Promise.reject(new Error("background upload requires Web Worker support"));
      }
      const workerUrl = URL.createObjectURL(
        new Blob([`(${fileUploadWorker.toString()})()`], { type: "text/javascript" }),
      );
      const worker = new Worker(workerUrl, { name: "dsh-file-upload" });
      URL.revokeObjectURL(workerUrl);
      return new Promise((resolve, reject) => {
        let settled = false;
        const abort = (): void => {
          settled = true;
          worker.terminate();
          request.signal?.removeEventListener("abort", abort);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          request.signal?.removeEventListener("abort", abort);
          worker.terminate();
          settle();
        };
        worker.onmessage = (event: MessageEvent<UploadWorkerOutput>) => {
          const output = event.data;
          if (output.kind === "progress") {
            request.onProgress?.({
              loaded: output.loaded,
              ...(output.total === undefined ? {} : { total: output.total }),
            });
          } else if (output.kind === "complete") {
            finish(() => {
              resolve({ status: output.status, body: output.body });
            });
          } else {
            finish(() => {
              reject(new Error(output.message));
            });
          }
        };
        worker.onerror = (event) => {
          finish(() => {
            reject(new Error(event.message || "background upload worker failed"));
          });
        };
        if (request.signal?.aborted === true) {
          abort();
          return;
        }
        request.signal?.addEventListener("abort", abort, { once: true });
        const message: UploadWorkerStart = {
          // The Worker's own base is `blob:`, so its request URL must be absolute.
          url: new URL(request.path, document.baseURI).href,
          body: request.body,
          headers: request.headers ?? {},
        };
        if (request.body instanceof ReadableStream) worker.postMessage(message, [request.body]);
        else worker.postMessage(message);
      });
    },
  };
}

function parseFileUploadResult(body: string): RemoteResult<FileUploadValue> {
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("file upload transport returned an invalid result");
  }
  if (!value.ok) {
    const error = value.error;
    if (
      !isRecord(error) ||
      typeof error.code !== "string" ||
      typeof error.message !== "string" ||
      !isRecord(error.details)
    ) {
      throw new TypeError("file upload transport returned an invalid failure");
    }
    return {
      ok: false,
      error: new RemoteError(error.code as never, error.message, error.details as never),
    };
  }
  const result = value.value;
  const file = isRecord(result) ? result.file : undefined;
  if (
    !isRecord(result) ||
    typeof result.receiptId !== "string" ||
    !isRecord(file) ||
    typeof file.attachmentId !== "string" ||
    typeof file.name !== "string" ||
    typeof file.bytes !== "number" ||
    !Number.isSafeInteger(file.bytes) ||
    file.bytes < 0
  ) {
    throw new TypeError("file upload transport returned an invalid receipt");
  }
  return {
    ok: true,
    value: {
      receiptId: result.receiptId as FileUploadValue["receiptId"],
      file: {
        attachmentId: file.attachmentId as FileUploadValue["file"]["attachmentId"],
        name: file.name,
        bytes: file.bytes,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
