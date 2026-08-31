import { existsSync, statSync } from "node:fs";
import path from "node:path";

const MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".m4v",
  ".mov",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".svg",
  ".wav",
  ".webm",
  ".webp",
]);

export interface RewriteLocalMediaMarkdownOptions {
  exists?: (absolutePath: string) => boolean;
  /** When true, omit a trailing unfinished `![alt](dest` so later rewrite stays prefix-stable. */
  holdIncomplete?: boolean;
}

export function grokMediaResolveRoots(cwd: string, sessionDirectory?: string): string[] {
  const roots = [path.resolve(cwd)];
  if (!sessionDirectory) return roots;
  const session = path.resolve(sessionDirectory);
  roots.push(session, path.join(session, "videos"), path.join(session, "images"));
  return roots;
}

export function rewriteLocalMediaMarkdown(
  text: string,
  roots: readonly string[],
  options: RewriteLocalMediaMarkdownOptions = {},
): string {
  const exists = options.exists ?? mediaFileExists;
  const holdIncomplete = options.holdIncomplete === true;
  let output = "";
  let index = 0;
  let fence = false;
  while (index < text.length) {
    if (!fence) {
      const fenceStart = text.indexOf("```", index);
      const imageStart = text.indexOf("![", index);
      if (fenceStart !== -1 && (imageStart === -1 || fenceStart < imageStart)) {
        output += text.slice(index, fenceStart + 3);
        index = fenceStart + 3;
        fence = true;
        continue;
      }
      if (imageStart === -1) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, imageStart);
      const parsed = parseMarkdownImage(text, imageStart);
      if (!parsed) {
        output += "!";
        index = imageStart + 1;
        continue;
      }
      if (!parsed.closed) {
        output += holdIncomplete
          ? text.slice(imageStart, parsed.destinationStart)
          : text.slice(imageStart);
        break;
      }
      const resolved = resolveLocalMediaPath(parsed.destination, roots, exists);
      output +=
        text.slice(imageStart, parsed.destinationStart) +
        formatMarkdownDestination(resolved ?? parsed.destination, parsed.bracketed) +
        text.slice(parsed.destinationEnd, parsed.end);
      index = parsed.end;
      continue;
    }
    const fenceEnd = text.indexOf("```", index);
    if (fenceEnd === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, fenceEnd + 3);
    index = fenceEnd + 3;
    fence = false;
  }
  return output;
}

function parseMarkdownImage(
  text: string,
  start: number,
): {
  closed: boolean;
  destination: string;
  destinationStart: number;
  destinationEnd: number;
  end: number;
  bracketed: boolean;
} | null {
  if (text.slice(start, start + 2) !== "![") return null;
  let index = start + 2;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n") return null;
    if (character === "\\" && index + 1 < text.length) {
      index += 2;
      continue;
    }
    if (character === "]") break;
    index += 1;
  }
  if (text[index] !== "]" || text[index + 1] !== "(") return null;
  const destinationStart = index + 2;
  index = destinationStart;
  while (text[index] === " " || text[index] === "\t") index += 1;
  if (index >= text.length) {
    return {
      closed: false,
      destination: "",
      destinationStart,
      destinationEnd: index,
      end: text.length,
      bracketed: false,
    };
  }
  let destination: string;
  let destinationEnd: number;
  let bracketed = false;
  if (text[index] === "<") {
    bracketed = true;
    const close = text.indexOf(">", index + 1);
    if (close === -1 || text.slice(index, close).includes("\n")) {
      return {
        closed: false,
        destination: text.slice(index + 1),
        destinationStart,
        destinationEnd: text.length,
        end: text.length,
        bracketed: true,
      };
    }
    destination = text.slice(index + 1, close);
    destinationEnd = close + 1;
    index = destinationEnd;
  } else {
    const begin = index;
    while (index < text.length) {
      const character = text[index];
      if (character === "\n" || character === " " || character === "\t" || character === ")") break;
      if (character === "\\" && index + 1 < text.length) {
        index += 2;
        continue;
      }
      index += 1;
    }
    destination = unescapeMarkdown(text.slice(begin, index));
    destinationEnd = index;
  }
  while (text[index] === " " || text[index] === "\t") index += 1;
  if (text[index] === '"' || text[index] === "'" || text[index] === "(") {
    const closer = text[index] === "(" ? ")" : text[index];
    index += 1;
    while (index < text.length && text[index] !== closer && text[index] !== "\n") index += 1;
    if (text[index] !== closer) {
      return {
        closed: false,
        destination,
        destinationStart,
        destinationEnd,
        end: text.length,
        bracketed,
      };
    }
    index += 1;
    while (text[index] === " " || text[index] === "\t") index += 1;
  }
  if (text[index] !== ")") {
    return {
      closed: false,
      destination,
      destinationStart,
      destinationEnd,
      end: text.length,
      bracketed,
    };
  }
  return {
    closed: true,
    destination,
    destinationStart,
    destinationEnd,
    end: index + 1,
    bracketed,
  };
}

function formatMarkdownDestination(destination: string, bracketed: boolean): string {
  if (bracketed || /[\s()]/.test(destination)) return `<${destination}>`;
  return destination.replaceAll(" ", "%20");
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\()])/g, "$1");
}

export function resolveLocalMediaPath(
  raw: string,
  roots: readonly string[],
  exists: (absolutePath: string) => boolean = mediaFileExists,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isRemoteMediaUrl(trimmed)) return null;
  const stripped = stripFileUrl(trimmed);
  if (!hasMediaExtension(stripped)) return null;
  if (isAbsoluteMediaPath(stripped)) {
    const absolute = path.resolve(stripped);
    return exists(absolute) ? absolute : null;
  }
  for (const root of roots) {
    const absolute = path.resolve(root, stripped);
    if (exists(absolute)) return absolute;
  }
  return null;
}

function isRemoteMediaUrl(value: string): boolean {
  return /^(?:https?:|data:|app:|blob:)/i.test(value);
}

function stripFileUrl(value: string): string {
  if (!value.toLowerCase().startsWith("file:")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return value;
    return decodeURIComponent(url.pathname);
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

function isAbsoluteMediaPath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function hasMediaExtension(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0] ?? value;
  return MEDIA_EXTENSIONS.has(path.extname(pathname).toLowerCase());
}

function mediaFileExists(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
