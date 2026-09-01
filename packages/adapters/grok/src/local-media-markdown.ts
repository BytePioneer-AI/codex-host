import { existsSync, statSync } from "node:fs";
import os from "node:os";
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
  if (sessionDirectory) {
    const session = path.resolve(sessionDirectory);
    roots.push(session, path.join(session, "videos"), path.join(session, "images"));
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  if (home) roots.push(path.join(home, "Downloads"));
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
    if (fence) {
      const fenceEnd = text.indexOf("```", index);
      if (fenceEnd === -1) {
        output += text.slice(index);
        break;
      }
      output += text.slice(index, fenceEnd + 3);
      index = fenceEnd + 3;
      fence = false;
      continue;
    }
    const fenceStart = text.indexOf("```", index);
    const imageStart = text.indexOf("![", index);
    const tickStart = indexOfInlineTick(text, index);
    const next = earliestIndex([fenceStart, imageStart, tickStart]);
    if (next === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, next);
    if (next === fenceStart) {
      output += "```";
      index = fenceStart + 3;
      fence = true;
      continue;
    }
    if (next === imageStart) {
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
    const inline = parseInlineCode(text, tickStart);
    if (!inline.closed) {
      if (!holdIncomplete) output += text.slice(tickStart);
      break;
    }
    const resolved = resolveLocalMediaPath(inline.content, roots, exists);
    output += resolved ? mediaMarkdownImage(resolved) : text.slice(tickStart, inline.end);
    index = inline.end;
  }
  return output;
}

function indexOfInlineTick(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const tick = text.indexOf("`", index);
    if (tick === -1) return -1;
    if (text.startsWith("```", tick)) {
      index = tick + 3;
      continue;
    }
    return tick;
  }
  return -1;
}

function earliestIndex(candidates: readonly number[]): number {
  let next = -1;
  for (const candidate of candidates) {
    if (candidate === -1) continue;
    if (next === -1 || candidate < next) next = candidate;
  }
  return next;
}

function parseInlineCode(
  text: string,
  start: number,
): { closed: boolean; content: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n")
      return { closed: false, content: text.slice(start + 1, index), end: index };
    if (character === "`")
      return { closed: true, content: text.slice(start + 1, index), end: index + 1 };
    index += 1;
  }
  return { closed: false, content: text.slice(start + 1), end: text.length };
}

function mediaMarkdownImage(absolutePath: string): string {
  const name = path.basename(absolutePath).replaceAll("]", "\\]");
  return `![${name}](${formatMarkdownDestination(absolutePath, false)})`;
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
