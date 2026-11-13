import { open } from "node:fs/promises";

import { desktopImageAttachmentPaths } from "@codexhost/shared-contracts";

import type { ClaudeUserContent } from "./transport.js";

type ClaudeImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type ClaudeImageBlock = Extract<Exclude<ClaudeUserContent, string>[number], { type: "image" }>;

/** Same cap as remote Desktop attachments; larger files stay path text. */
const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
/** Messages API limit per base64 image. */
const MAX_STEER_BASE64_BYTES = 5 * 1024 * 1024;
/** Stays within the Messages API pixel limit for requests that carry many images. */
const MAX_STEER_IMAGE_SIDE = 2000;
/** Enough for every signature and the PNG, GIF and WebP dimension fields. */
const HEADER_BYTES = 32;

/** The image formats the Messages API accepts, identified by file signature. */
function imageMediaType(data: Buffer): ClaudeImageMediaType | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  const head = data.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return null;
}

function jpegDimensions(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 <= data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}

/** Pixel size from the format's header; null when the header is not understood. */
function imageDimensions(
  data: Buffer,
  mediaType: ClaudeImageMediaType,
): { width: number; height: number } | null {
  if (data.length < 30) return null;
  switch (mediaType) {
    case "image/png":
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    case "image/gif":
      return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    case "image/webp": {
      const chunk = data.toString("latin1", 12, 16);
      if (chunk === "VP8 ") {
        return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === "VP8L") {
        const bits = data.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") {
        return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
      }
      return null;
    }
    case "image/jpeg":
      return jpegDimensions(data);
  }
}

/**
 * Claude Code shrinks image blocks of a prompt it starts as a Turn, but passes those of an input
 * joining the running Turn to the Messages API unchanged. Such an image must already fit.
 */
function fitsSteer(data: Buffer, mediaType: ClaudeImageMediaType): boolean {
  if (Math.ceil(data.length / 3) * 4 > MAX_STEER_BASE64_BYTES) return false;
  const size = imageDimensions(data, mediaType);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_STEER_IMAGE_SIDE &&
    size.height <= MAX_STEER_IMAGE_SIDE
  );
}

async function imageBlock(file: string, steer: boolean): Promise<ClaudeImageBlock | null> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_IMAGE_FILE_BYTES) return null;
    if (steer && Math.ceil(stats.size / 3) * 4 > MAX_STEER_BASE64_BYTES) return null;
    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
    const mediaType = imageMediaType(header.subarray(0, bytesRead));
    if (!mediaType) return null;
    const data = await handle.readFile();
    // The file can grow after stat.
    if (data.length > MAX_IMAGE_FILE_BYTES) return null;
    if (steer && !fitsSteer(data, mediaType)) return null;
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Desktop names attached images only as paths in its attachment context. Claude Code receives the
 * prompt text unchanged, followed by each distinct attached image as a native image block, the
 * same order Claude Code uses for pasted images. An image that cannot become a block (unreadable,
 * over 20 MiB, a format the Messages API does not take, or for a steer too large to send
 * unchanged) stays only a path in the prompt text, which Claude can still read. Without image
 * blocks the prompt is plain text.
 */
export async function claudeUserContent(
  text: string,
  { steer = false }: { steer?: boolean } = {},
): Promise<ClaudeUserContent> {
  const paths = [...new Set(desktopImageAttachmentPaths(text))];
  if (paths.length === 0) return text;
  const content: Exclude<ClaudeUserContent, string> = [{ type: "text", text }];
  for (const file of paths) {
    const block = await imageBlock(file, steer);
    if (block) content.push(block);
  }
  return content.length > 1 ? content : text;
}
