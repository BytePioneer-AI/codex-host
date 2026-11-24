/** Hub-side remote peer attachment uploads, prompts, placeholder projection, and image proxying. */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { posix } from "node:path";
import * as c from "@codexhost/shared-contracts";
import { imageViewProjectionKey, type ChThreadView } from "./ch-thread-view.ts";
import {
  imagePath,
  localImagePath,
  nativeUserInput,
  type NativeImageSource,
} from "./native-user-input.ts";
import { peerFetch, type PeerHostClient } from "./peer-host-client.ts";
import { RpcError } from "./transport.ts";
import type { WebFileRef } from "./web-files.ts";
import { inspectImage, WEB_IMAGE_LIMITS, type WebImageRef } from "./web-images.ts";

export type PeerAttachmentEndpoint = Pick<PeerHostClient, "record" | "state" | "manifest">;

export type PeerUploadTarget = { threadId: string } | { scope: string };

export interface PeerImageAttachmentRef extends WebImageRef {
  name: string;
}

export interface PeerAttachmentProjector {
  projectInput(content: unknown[]): unknown[];
  projectImage(path: string, projectionKey: string): PeerImageAttachmentRef;
}

export interface RemotePeerAttachmentsOptions {
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const SAFE_PROXY_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function peerImageId(
  threadId: string,
  target: string | NativeImageSource,
  projectionKey?: string,
): string {
  return `peer-image:${sha256Hex(
    JSON.stringify(
      projectionKey === undefined ? [threadId, target] : [threadId, target, projectionKey],
    ),
  )}`;
}

function sourceImageId(threadId: string, source: NativeImageSource): string {
  const path = imagePath(source);
  return peerImageId(threadId, path ?? source);
}

function pathLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return posix.basename(normalized) || "image";
}

function placeholderImage(
  threadId: string,
  source: NativeImageSource,
  name?: string,
  projectionKey?: string,
): PeerImageAttachmentRef {
  const path = imagePath(source);
  const attachmentId =
    projectionKey !== undefined && path !== undefined
      ? peerImageId(threadId, path, projectionKey)
      : sourceImageId(threadId, source);
  const label = name ?? (path ? pathLabel(path) : "image");
  return {
    attachmentId,
    name: label,
    mediaType: "image/png",
    bytes: 0,
    width: 64,
    height: 64,
  };
}

function toReadableStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

function extractPeerHttpStatus(error: RpcError): number | undefined {
  const status = (error.details as { httpStatus?: unknown }).httpStatus;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
        reason: "IMAGE_TOO_LARGE",
      });
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
          reason: "IMAGE_TOO_LARGE",
        });
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, total);
}

function decodeDataImageUrl(url: string): ReturnType<typeof inspectImage> {
  if (url.length > Math.ceil(WEB_IMAGE_LIMITS.maxImageBytes / 3) * 4 + 64) {
    throw new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
      reason: "IMAGE_TOO_LARGE",
    });
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url);
  if (!match?.[1] || !match[2]) {
    throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) {
    throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
  }
  return inspectImage(bytes, match[1]);
}

function writeProxyError(
  response: ServerResponse,
  status: number,
  message: string,
  isHead: boolean,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response
    .writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      ...SAFE_PROXY_HEADERS,
    })
    .end(isHead ? undefined : message);
}

function findProjectedAttachment(
  view: ChThreadView,
  eventType: "assistant/message" | "user/message",
  attachmentId: string,
): PeerImageAttachmentRef | undefined {
  for (const event of view.log.events) {
    if (event.type !== eventType) continue;
    const data = event.data as {
      content?: Array<{ type?: string; attachment?: PeerImageAttachmentRef }>;
      message?: { content?: Array<{ type?: string; attachment?: PeerImageAttachmentRef }> };
    };
    const parts = eventType === "assistant/message" ? data.message?.content : data.content;
    const found = parts?.find(
      (part) => part.type === "image" && part.attachment?.attachmentId === attachmentId,
    )?.attachment;
    if (found) return found;
  }
  return undefined;
}

export class RemotePeerAttachments {
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(options: RemotePeerAttachmentsOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  supported(peer: PeerAttachmentEndpoint | undefined): boolean {
    return peer?.state === "connected" && peer.manifest?.capabilities?.attachments === 1;
  }

  private requireSupported(peer: PeerAttachmentEndpoint | undefined): PeerAttachmentEndpoint {
    if (!this.supported(peer) || !peer) {
      throw new RpcError(
        "remote/attachments-unsupported",
        "Remote peer does not support attachments.",
      );
    }
    return peer;
  }

  async upload(
    peer: PeerAttachmentEndpoint | undefined,
    target: PeerUploadTarget,
    chunks: AsyncIterable<Uint8Array>,
    name?: string,
    imageMediaType?: string,
  ): Promise<{ receiptId: string; file: WebFileRef }> {
    const activePeer = this.requireSupported(peer);
    const query = new URLSearchParams();
    if ("threadId" in target) {
      if (!target.threadId) {
        throw new RpcError("session/attachment-invalid", "Invalid remote threadId.");
      }
      query.set("threadId", target.threadId);
    } else {
      if (!c.REMOTE_PEER_UPLOAD_SCOPE_PATTERN.test(target.scope)) {
        throw new RpcError("session/attachment-invalid", "Invalid remote upload scope.");
      }
      query.set("scope", target.scope);
    }
    if (name !== undefined) query.set("name", name);
    if (imageMediaType !== undefined) query.set("imageMediaType", imageMediaType);

    const response = await peerFetch(
      activePeer.record,
      `/api/peer/v1/uploads?${query.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: toReadableStream(chunks),
        duplex: "half",
        timeoutMs: this.uploadTimeoutMs,
      },
    );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RpcError(
        "remote/request-failed",
        "Remote peer returned an invalid upload response",
      );
    }
    const parsed = c.remotePeerUploadResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new RpcError(
        "remote/request-failed",
        "Remote peer returned an invalid upload response",
      );
    }
    if (!parsed.data.ok) {
      throw new RpcError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details ?? {},
      );
    }
    return parsed.data.value;
  }

  async prompt(
    peer: PeerAttachmentEndpoint | undefined,
    params: c.RemotePeerPromptParams,
  ): Promise<{ accepted: true }> {
    const activePeer = this.requireSupported(peer);
    const rawContent = (params as { content?: unknown }).content;
    if (
      Array.isArray(rawContent) &&
      rawContent.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "image",
      )
    ) {
      throw new RpcError(
        "session/attachment-invalid",
        "Encoded image parts are not supported for remote peer sessions.",
        { reason: "REMOTE_ENCODED_IMAGE_UNSUPPORTED" },
      );
    }
    const validated = c.remotePeerPromptParamsSchema.safeParse(params);
    if (!validated.success) {
      throw new RpcError("session/attachment-invalid", "Invalid remote peer prompt parameters.");
    }
    const response = await peerFetch(activePeer.record, "/api/peer/v1/prompt", {
      method: "POST",
      body: validated.data,
      timeoutMs: this.requestTimeoutMs,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RpcError(
        "remote/request-failed",
        "Remote peer returned an invalid prompt response",
      );
    }
    const parsed = c.remotePeerPromptResultSchema.safeParse(payload);
    if (!parsed.success) {
      throw new RpcError(
        "remote/request-failed",
        "Remote peer returned an invalid prompt response",
      );
    }
    if (!parsed.data.ok) {
      throw new RpcError(
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details ?? {},
      );
    }
    return parsed.data.value;
  }

  projector(threadId: string): PeerAttachmentProjector {
    return {
      projectInput: (content: unknown[]): unknown[] =>
        nativeUserInput(content).map((part) => {
          if (part.type === "other") return part.value;
          if (part.type === "text") return part;
          if (part.type === "nativeFile") {
            return {
              type: "file",
              attachment: {
                attachmentId: `peer-file:${sha256Hex(JSON.stringify([threadId, part]))}`,
                name: part.name,
                nativePath: part.path,
                bytes: 0,
                mediaType: "application/octet-stream",
                ...(part.startLine !== undefined
                  ? { startLine: part.startLine, endLine: part.endLine }
                  : {}),
              },
            };
          }
          return {
            type: "image",
            attachment: placeholderImage(threadId, part.source, part.name),
          };
        }),
      projectImage: (path: string, projectionKey: string): PeerImageAttachmentRef =>
        placeholderImage(threadId, { path }, undefined, projectionKey),
    };
  }

  async readAttachment(
    peer: PeerAttachmentEndpoint | undefined,
    view: ChThreadView,
    threadId: string,
    attachmentId: string,
  ): Promise<{ attachment: PeerImageAttachmentRef; data: string }> {
    const activePeer = this.requireSupported(peer);
    const resolved = this.resolveViewAttachment(view, threadId, attachmentId);
    if (!resolved) {
      throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
    }
    const { source, expected } = resolved;
    const nativePath = imagePath(source);
    if (nativePath === undefined) {
      if (!("url" in source)) {
        throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
      }
      const image = decodeDataImageUrl(source.url);
      return {
        attachment: { ...expected, ...image.ref, attachmentId },
        data: image.bytes.toString("base64"),
      };
    }

    const query = new URLSearchParams({ threadId, path: nativePath });
    let response: Response;
    try {
      response = await peerFetch(activePeer.record, `/api/peer/v1/file?${query.toString()}`, {
        method: "GET",
        timeoutMs: this.requestTimeoutMs,
      });
    } catch (error) {
      if (error instanceof RpcError) {
        const status = extractPeerHttpStatus(error);
        if (status === 404) {
          throw new RpcError(
            "session/attachment-not-found",
            "The referenced image is unavailable.",
          );
        }
        if (status === 413) {
          throw new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
            reason: "IMAGE_TOO_LARGE",
          });
        }
      }
      throw error;
    }
    const bytes = await readBoundedBytes(response, WEB_IMAGE_LIMITS.maxImageBytes);
    let image;
    try {
      image = inspectImage(bytes);
    } catch (error) {
      if (
        error instanceof RpcError &&
        "reason" in error.details &&
        (error.details.reason === "IMAGE_TOO_LARGE" ||
          error.details.reason === "IMAGE_TOO_MANY_PIXELS")
      ) {
        throw error;
      }
      throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
    }
    return {
      attachment: { ...expected, ...image.ref, attachmentId },
      data: image.bytes.toString("base64"),
    };
  }

  private resolveViewAttachment(
    view: ChThreadView,
    threadId: string,
    attachmentId: string,
  ): { source: NativeImageSource; expected: PeerImageAttachmentRef } | undefined {
    const assistantExpected = findProjectedAttachment(view, "assistant/message", attachmentId);
    if (assistantExpected) {
      for (const turn of view.thread.turns) {
        for (const item of turn.items) {
          if (item.type !== "imageView" || typeof item.path !== "string") continue;
          const path = localImagePath(item.path);
          if (path === undefined) continue;
          const projectionKey = imageViewProjectionKey(turn.id, item.id);
          if (peerImageId(threadId, path, projectionKey) === attachmentId) {
            return { source: { path }, expected: assistantExpected };
          }
        }
      }
      return undefined;
    }

    const userExpected = findProjectedAttachment(view, "user/message", attachmentId);
    if (!userExpected) return undefined;
    for (const turn of view.thread.turns) {
      for (const item of turn.items) {
        if (item.type !== "userMessage" || !Array.isArray(item.content)) continue;
        for (const part of nativeUserInput(item.content)) {
          if (
            part.type === "nativeImage" &&
            sourceImageId(threadId, part.source) === attachmentId
          ) {
            return { source: part.source, expected: userExpected };
          }
        }
      }
    }
    return undefined;
  }

  async serveFile(
    peer: PeerAttachmentEndpoint | undefined,
    threadId: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      writeProxyError(response, 405, "method not allowed", false);
      return;
    }
    if (!threadId || !path) {
      writeProxyError(response, 400, "missing parameters", isHead);
      return;
    }
    if (!this.supported(peer) || !peer) {
      writeProxyError(response, 404, "image unavailable", isHead);
      return;
    }
    const abort = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once("close", onClose);
    const query = new URLSearchParams({ threadId, path });
    try {
      const upstream = await peerFetch(peer.record, `/api/peer/v1/file?${query.toString()}`, {
        method: isHead ? "HEAD" : "GET",
        signal: abort.signal,
        timeoutMs: this.requestTimeoutMs,
      });
      const remoteType =
        upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!WEB_IMAGE_LIMITS.mediaTypes.includes(remoteType)) {
        await upstream.body?.cancel().catch(() => undefined);
        writeProxyError(response, 502, "remote peer returned non-image response", isHead);
        return;
      }
      if (isHead) {
        const rawLength = upstream.headers.get("content-length");
        const parsedLength = rawLength !== null ? Number(rawLength) : undefined;
        if (parsedLength !== undefined && Number.isFinite(parsedLength)) {
          if (parsedLength > WEB_IMAGE_LIMITS.maxImageBytes) {
            writeProxyError(response, 413, "image too large", true);
            return;
          }
        }
        response.writeHead(200, {
          "Content-Type": remoteType,
          ...(parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength >= 0
            ? { "Content-Length": String(parsedLength) }
            : {}),
          ...SAFE_PROXY_HEADERS,
        });
        response.end();
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedBytes(upstream, WEB_IMAGE_LIMITS.maxImageBytes);
      } catch (error) {
        if (
          error instanceof RpcError &&
          "reason" in error.details &&
          error.details.reason === "IMAGE_TOO_LARGE"
        ) {
          writeProxyError(response, 413, "image too large", false);
          return;
        }
        writeProxyError(response, 502, "remote peer unavailable", false);
        return;
      }
      let image;
      try {
        image = inspectImage(bytes);
      } catch (error) {
        const reason =
          error instanceof RpcError && "reason" in error.details ? error.details.reason : undefined;
        if (reason === "IMAGE_TOO_LARGE" || reason === "IMAGE_TOO_MANY_PIXELS") {
          writeProxyError(response, 413, "image too large", false);
          return;
        }
        writeProxyError(response, 502, "remote peer returned invalid image", false);
        return;
      }
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(200, {
        "Content-Type": image.ref.mediaType,
        "Content-Length": String(image.bytes.length),
        ...SAFE_PROXY_HEADERS,
      });
      response.end(image.bytes);
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      if (error instanceof RpcError) {
        const status = extractPeerHttpStatus(error);
        if (status !== undefined && status >= 400 && status < 500) {
          const message =
            status === 404
              ? "image unavailable"
              : status === 413
                ? "image too large"
                : "request rejected";
          writeProxyError(response, status, message, isHead);
          return;
        }
      }
      writeProxyError(response, 502, "remote peer unavailable", isHead);
    } finally {
      response.off("close", onClose);
    }
  }
}
