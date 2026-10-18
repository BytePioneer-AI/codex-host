import path from "node:path";

import type { HostGeneratedImageItem } from "@codexhost/harness-adapter";
import type { HostItemId } from "@codexhost/shared-contracts";

import { validAbsolutePath } from "./grok-file-change.js";
import { mediaFileExists } from "./local-media-markdown.js";

const GENERATED_IMAGE_TYPES = new Set(["ImageGen", "ImageEdit"]);

export interface GrokGeneratedImage {
  savedPath: string;
  revisedPrompt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].length > 0
    ? value[key]
    : undefined;
}

function fromNativeRecord(
  value: unknown,
  exists: (absolutePath: string) => boolean,
): GrokGeneratedImage | null {
  if (!isRecord(value)) return null;
  const type = stringField(value, "type");
  const sessionFolder = stringField(value, "session_folder");
  const typed = type !== undefined && GENERATED_IMAGE_TYPES.has(type);
  const imageFolder = sessionFolder === "images";
  if (!typed && !imageFolder) return null;
  const savedPath = stringField(value, "path");
  if (!validAbsolutePath(savedPath)) return null;
  const resolved = path.resolve(savedPath);
  if (!exists(resolved)) return null;
  const filename = stringField(value, "filename");
  return {
    savedPath: resolved,
    ...(filename ? { revisedPrompt: filename } : {}),
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read Grok Imagine ACP output. Only ImageGen/ImageEdit native records qualify;
 * tool names and markdown links are ignored.
 */
export function projectGrokGeneratedImage(
  content: unknown,
  rawOutput: unknown,
  exists: (absolutePath: string) => boolean = mediaFileExists,
): GrokGeneratedImage | null {
  const fromRaw = fromNativeRecord(rawOutput, exists);
  if (fromRaw) return fromRaw;
  if (!Array.isArray(content)) return null;
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const nested = entry.type === "content" && isRecord(entry.content) ? entry.content : entry;
    if (isRecord(nested) && nested.type === "text" && typeof nested.text === "string") {
      const parsed = fromNativeRecord(parseJsonObject(nested.text), exists);
      if (parsed) return parsed;
    }
    const direct = fromNativeRecord(nested, exists);
    if (direct) return direct;
  }
  return null;
}

export function mergeGrokGeneratedImage(
  previous: GrokGeneratedImage | undefined,
  next: GrokGeneratedImage | null,
): GrokGeneratedImage | undefined {
  return next ?? previous;
}

export function grokGeneratedImageItem(
  image: GrokGeneratedImage,
  itemId: HostItemId,
  sourceItemId: HostItemId,
): HostGeneratedImageItem {
  return {
    type: "generatedImage",
    itemId,
    savedPath: image.savedPath,
    sourceItemIds: [sourceItemId],
    ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
  };
}
