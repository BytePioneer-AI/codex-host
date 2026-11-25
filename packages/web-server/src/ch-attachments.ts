/** Disposable native attachment presentation. CH history owns references; local files own bytes. */
import { createHash } from "node:crypto";
import { basename, resolve, isAbsolute } from "node:path";
import {
  imagePath,
  localImagePath,
  nativeUserInput,
  type NativeImage,
  type NativeImageSource,
} from "./native-user-input.ts";
import {
  type WebImages,
  inspectImage,
  readImageFile,
  WEB_IMAGE_LIMITS,
  type WebImageRef,
} from "./web-images.ts";
import { imageViewProjectionKey, type ChThreadView } from "./ch-thread-view.ts";
import type { WebFiles } from "./web-files.ts";
import type { WireEvent } from "./session-log.ts";
import { RpcError } from "./transport.ts";

interface ImageRef extends WebImageRef {
  name: string;
  /** Captured at projection time, never supplied by the browser during a read. */
  fingerprint?: string;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unavailable(): never {
  throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
}

export class ChAttachments {
  constructor(
    private readonly images: WebImages,
    private readonly files?: WebFiles,
  ) {}

  private id(threadId: string, source: NativeImageSource, observationId?: string): string {
    const path = imagePath(source);
    const owned = !observationId && path ? this.images.idForPath(path) : undefined;
    if (owned) return owned;
    // Native IDs are opaque, stable across Web restarts and scoped to a Thread.
    // They cannot be decoded into a user-supplied path by the download endpoint.
    const key = path
      ? {
          path: isAbsolute(path) ? resolve(path) : path,
          ...(observationId === undefined ? {} : { observationId }),
        }
      : source;
    return `ch-image:${hash(JSON.stringify([threadId, key]))}`;
  }

  private bytes(source: NativeImageSource): ReturnType<typeof inspectImage> {
    const path = imagePath(source);
    if (path !== undefined) {
      const owned = this.images.idForPath(path);
      if (owned) return this.images.readBytes(owned);
      return inspectImage(readImageFile(path));
    }
    if (!("url" in source)) return unavailable();
    // Never fetch HTTP/HTTPS, app: or blob: URLs from the server (including SSRF targets).
    if (source.url.length > Math.ceil(WEB_IMAGE_LIMITS.maxImageBytes / 3) * 4 + 64)
      throw new RpcError("session/attachment-invalid", "Image exceeds 50 MiB.", {
        reason: "IMAGE_TOO_LARGE",
      });
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
      source.url,
    );
    if (!match?.[1] || !match[2]) return unavailable();
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2]) return unavailable();
    return inspectImage(bytes, match[1]);
  }

  private image(
    threadId: string,
    source: NativeImageSource,
    name?: string,
    observationId?: string,
  ): ImageRef {
    const attachmentId = this.id(threadId, source, observationId);
    const path = imagePath(source);
    const label = name ?? (path ? basename(path.replaceAll("\\", "/")) : "image");
    const fallback: ImageRef = {
      attachmentId,
      name: label,
      mediaType: "image/png",
      bytes: 0,
      width: 64,
      height: 64,
    };
    try {
      const image = this.bytes(source);
      return { ...image.ref, attachmentId, name: label, fingerprint: image.leaf };
    } catch {
      // Keep a placeholder so a transiently unavailable native file can be retried.
      return fallback;
    }
  }

  /** Project one native ImageView display item into the assistant image wire shape. */
  projectImageView(threadId: string, path: string, observationId?: string): ImageRef {
    return this.image(threadId, { path }, undefined, observationId);
  }

  project(threadId: string, content: readonly unknown[]): unknown[] {
    return nativeUserInput(content).map((part) => {
      if (part.type === "other") return part.value;
      if (part.type === "text") return part;
      if (part.type === "nativeFile") {
        const owned = this.files?.reference(part.path);
        if (owned) return { type: "file", attachment: owned };
        return {
          type: "file",
          attachment: {
            attachmentId: `ch-file:${hash(JSON.stringify([threadId, part]))}`,
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
      return { type: "image", attachment: this.image(threadId, part.source, part.name) };
    });
  }

  /** Match both the projected reference and canonical input in the loaded history or active queue.
   * No browser path, label, metadata or guessed ID can extend that authority.
   */
  read(
    view: ChThreadView,
    attachmentId: string,
    queuedInputs?: readonly (readonly unknown[])[],
  ): { attachment: ImageRef; data: string } {
    const imageView = this.imageView(view, attachmentId);
    if (imageView !== undefined) {
      const expected = this.assistantAttachment(view.log.events, attachmentId);
      // An imageView is an immutable snapshot of one displayed image. If its first
      // projection could not read a fingerprint, later bytes must not become readable.
      if (!expected?.fingerprint) return unavailable();
      return this.readSource(imageView, expected, attachmentId);
    }
    const history = this.tryReadInputs(
      view.thread.id,
      view.thread.turns.map((turn) =>
        turn.items
          .filter((item) => item.type === "userMessage")
          .flatMap((item) => (Array.isArray(item.content) ? item.content : [])),
      ),
      this.message(view.log.events, attachmentId),
      attachmentId,
    );
    if (history) return history;
    if (queuedInputs?.length) {
      const inbox = view.log.projections.inbox as
        { "next-turn"?: ReadonlyArray<{ content?: unknown[] }> } | undefined;
      const queued = this.tryReadInputs(
        view.thread.id,
        queuedInputs,
        this.messageFromContents(
          (inbox?.["next-turn"] ?? []).map((row) => row.content),
          attachmentId,
        ),
        attachmentId,
      );
      if (queued) return queued;
    }
    return unavailable();
  }

  private imageView(view: ChThreadView, attachmentId: string): NativeImageSource | undefined {
    for (const turn of view.thread.turns) {
      for (const item of turn.items) {
        if (item.type !== "imageView" || typeof item.path !== "string") continue;
        const path = localImagePath(item.path);
        if (path === undefined) continue;
        const source: NativeImageSource = { path };
        const observationId = imageViewProjectionKey(turn.id, item.id);
        if (this.id(view.thread.id, source, observationId) === attachmentId) return source;
      }
    }
    return undefined;
  }

  private assistantAttachment(
    events: readonly Pick<WireEvent, "type" | "data">[],
    attachmentId: string,
  ): ImageRef | undefined {
    for (const event of events) {
      if (event.type !== "assistant/message") continue;
      const data = event.data as {
        message?: { content?: Array<{ type?: string; attachment?: ImageRef }> };
      };
      const expected = data.message?.content?.find(
        (part) => part.type === "image" && part.attachment?.attachmentId === attachmentId,
      )?.attachment;
      if (expected) return expected;
    }
    return undefined;
  }

  private readSource(
    source: NativeImageSource,
    expected: ImageRef,
    attachmentId: string,
  ): { attachment: ImageRef; data: string } {
    try {
      const image = this.bytes(source);
      if (expected.fingerprint && expected.fingerprint !== image.leaf) return unavailable();
      return {
        attachment: { ...expected, ...image.ref, attachmentId, fingerprint: image.leaf },
        data: image.bytes.toString("base64"),
      };
    } catch (error) {
      if (
        error instanceof RpcError &&
        "reason" in error.details &&
        (error.details.reason === "IMAGE_TOO_LARGE" ||
          error.details.reason === "IMAGE_TOO_MANY_PIXELS")
      )
        throw error;
      return unavailable();
    }
  }

  readEvents(threadId: string, events: readonly WireEvent[], attachmentId: string) {
    const inputs = events
      .filter((event) => event.type === "user/message")
      .map((event) => (event.data as { content: unknown[] }).content);
    const projected = inputs.map((content) => ({
      type: "user/message",
      data: { content: this.project(threadId, content) },
    }));
    const message = this.message(projected, attachmentId);
    return message ? this.readInputs(threadId, inputs, message, attachmentId) : undefined;
  }

  private tryReadInputs(
    threadId: string,
    inputs: readonly (readonly unknown[])[],
    message: ImageRef[] | undefined,
    attachmentId: string,
  ): { attachment: ImageRef; data: string } | undefined {
    const expected = message?.find((ref) => ref.attachmentId === attachmentId);
    if (!expected) return undefined;
    let source: NativeImage | undefined;
    for (const input of inputs) {
      source = nativeUserInput(input).find(
        (part): part is NativeImage =>
          part.type === "nativeImage" && this.id(threadId, part.source) === attachmentId,
      );
      if (source) break;
    }
    if (!source) return undefined;
    return this.readSource(source.source, expected, attachmentId);
  }

  private readInputs(
    threadId: string,
    inputs: readonly unknown[][],
    message: ImageRef[] | undefined,
    attachmentId: string,
  ): { attachment: ImageRef; data: string } {
    return this.tryReadInputs(threadId, inputs, message, attachmentId) ?? unavailable();
  }

  private messageFromContents(
    contents: ReadonlyArray<unknown[] | undefined>,
    id: string,
  ): ImageRef[] | undefined {
    for (const content of contents) {
      if (!Array.isArray(content)) continue;
      const refs = content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const image = part as { type?: string; attachment?: ImageRef };
        return image.type === "image" && image.attachment ? [image.attachment] : [];
      });
      if (refs.some((ref) => ref.attachmentId === id)) return refs;
    }
    return undefined;
  }

  private message(
    events: readonly Pick<WireEvent, "type" | "data">[],
    id: string,
  ): ImageRef[] | undefined {
    return this.messageFromContents(
      events
        .filter((event) => event.type === "user/message")
        .map((event) => (event.data as { content?: unknown[] }).content),
      id,
    );
  }
}
