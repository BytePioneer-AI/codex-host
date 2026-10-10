/** Disposable native attachment presentation. CH history owns references; local files own bytes. */
import { createHash } from "node:crypto";
import { basename, resolve, isAbsolute } from "node:path";
import {
  imagePath,
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
import type { ChThreadView } from "./ch-thread-view.ts";
import type { WireEvent } from "./session-log.ts";
import { RpcError } from "./transport.ts";

interface ImageRef extends WebImageRef {
  name: string;
  /** Captured at projection time, never supplied by the browser during a read. */
  fingerprint?: string;
  unavailable?: boolean;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function unavailable(): never {
  throw new RpcError("session/attachment-not-found", "The referenced image is unavailable.");
}

export class ChAttachments {
  constructor(private readonly images: WebImages) {}

  private id(threadId: string, source: NativeImageSource): string {
    const path = imagePath(source);
    const owned = path ? this.images.idForPath(path) : undefined;
    if (owned) return owned;
    // Native IDs are opaque, stable across Web restarts and scoped to a Thread.
    // They cannot be decoded into a user-supplied path by the download endpoint.
    const key = path ? { path: isAbsolute(path) ? resolve(path) : path } : source;
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
      return unavailable();
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
      source.url,
    );
    if (!match?.[1] || !match[2]) return unavailable();
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2]) return unavailable();
    return inspectImage(bytes, match[1]);
  }

  project(threadId: string, content: readonly unknown[]): unknown[] {
    let count = 0;
    let total = 0;
    return nativeUserInput(content).map((part) => {
      if (part.type === "other") return part.value;
      if (part.type === "text") return part;
      if (part.type === "nativeFile") {
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
      const attachmentId = this.id(threadId, part.source);
      const path = imagePath(part.source);
      const name = part.name ?? (path ? basename(path.replaceAll("\\", "/")) : "image");
      const fallback: ImageRef = {
        attachmentId,
        name,
        mediaType: "image/png",
        bytes: 0,
        width: 64,
        height: 64,
      };
      if (++count > WEB_IMAGE_LIMITS.maxImagesPerMessage) {
        fallback.unavailable = true;
        return { type: "image", attachment: fallback };
      }
      try {
        const image = this.bytes(part.source);
        total += image.bytes.length;
        if (total > WEB_IMAGE_LIMITS.maxMessageImageBytes) {
          fallback.unavailable = true;
          return { type: "image", attachment: fallback };
        }
        const attachment: ImageRef = {
          ...image.ref,
          attachmentId,
          name,
          fingerprint: image.leaf,
        };
        return { type: "image", attachment };
      } catch {
        // Keep the user's request and an image placeholder even if a native temp
        // file has disappeared. A subsequent explicit retry may recover it.
        return { type: "image", attachment: fallback };
      }
    });
  }

  /** Match both the projected reference and canonical input in the loaded history.
   * No browser path, label, metadata or guessed ID can extend that authority.
   */
  read(view: ChThreadView, attachmentId: string): { attachment: ImageRef; data: string } {
    const message = this.message(view.log.events, attachmentId);
    const expected = message?.find((ref) => ref.attachmentId === attachmentId);
    if (!expected || expected.unavailable) return unavailable();
    let source: NativeImage | undefined;
    for (const turn of view.thread.turns) {
      const input = turn.items
        .filter((item) => item.type === "userMessage")
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
      source = nativeUserInput(input).find(
        (part): part is NativeImage =>
          part.type === "nativeImage" && this.id(view.thread.id, part.source) === attachmentId,
      );
      if (source) break;
    }
    if (!source) return unavailable();
    try {
      const image = this.bytes(source.source);
      if (expected.fingerprint && expected.fingerprint !== image.leaf) return unavailable();
      const otherBytes =
        message?.reduce((sum, ref) => sum + (ref === expected ? 0 : ref.bytes), 0) ?? 0;
      if (otherBytes + image.bytes.length > WEB_IMAGE_LIMITS.maxMessageImageBytes)
        return unavailable();
      return {
        attachment: { ...expected, ...image.ref, attachmentId, fingerprint: image.leaf },
        data: image.bytes.toString("base64"),
      };
    } catch {
      return unavailable();
    }
  }

  private message(events: readonly WireEvent[], id: string): ImageRef[] | undefined {
    for (const event of events) {
      if (event.type !== "user/message") continue;
      const data = event.data as { content?: Array<{ type?: string; attachment?: ImageRef }> };
      const refs = data.content?.flatMap((part) =>
        part.type === "image" && part.attachment ? [part.attachment] : [],
      );
      if (refs?.some((ref) => ref.attachmentId === id)) return refs;
    }
    return undefined;
  }
}
