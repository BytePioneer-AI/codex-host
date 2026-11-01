import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Whether an absolute candidate path is a media file Codex Desktop can load. */
export type LocalMediaExists = (absolutePath: string) => boolean;

export interface RewriteLocalMediaMarkdownOptions {
  exists?: LocalMediaExists;
  /**
   * Hold back a trailing construct that later text could still complete or invalidate
   * (an open image or inline code span), so a growing text projects prefix-stably.
   */
  holdIncomplete?: boolean;
}

/**
 * Codex Desktop loads a Markdown image from local disk only when its destination is an absolute
 * path or `file:` URL; it resolves any other destination against its own page. Rewrite local
 * media in image destinations, and inline code holding only a media path, to absolute paths
 * found using `roots` as search order, not as a sandbox. Remote URLs and missing files stay
 * unchanged; container/indented fence-like regions keep the remaining message verbatim.
 */
export function rewriteLocalMediaMarkdown(
  text: string,
  roots: readonly string[],
  options: RewriteLocalMediaMarkdownOptions = {},
): string {
  return projectLocalMedia(
    text,
    roots,
    options.exists ?? mediaFileExists,
    options.holdIncomplete === true,
  ).text;
}

/**
 * Streams native agent text through {@link rewriteLocalMediaMarkdown} as append-only deltas.
 * Published text never changes: a trailing construct waits until later text decides it, `flush`
 * releases it, and each file check is remembered so one message resolves a path one way.
 */
export class LocalMediaMarkdownStream {
  readonly #roots: readonly string[];
  readonly #exists: LocalMediaExists;
  #native = "";
  #text = "";
  /** Native text length represented by `#text`; the rest is held. */
  #consumed = 0;
  #verbatim = false;

  constructor(roots: readonly string[], exists: LocalMediaExists = mediaFileExists) {
    this.#roots = [...roots];
    const known = new Map<string, boolean>();
    this.#exists = (absolutePath) => {
      let found = known.get(absolutePath);
      if (found === undefined) {
        found = exists(absolutePath);
        known.set(absolutePath, found);
      }
      return found;
    };
  }

  /** Projected text published so far: every returned delta, concatenated. */
  get text(): string {
    return this.#text;
  }

  /** Add native text and return the projected text it makes publishable, possibly empty. */
  append(text: string): string {
    this.#native += text;
    return this.#advance(true);
  }

  /** Return the projected text still held at the end of the stream. */
  flush(): string {
    return this.#advance(false);
  }

  #advance(holdIncomplete: boolean): string {
    const next = this.#verbatim
      ? undefined
      : projectLocalMedia(this.#native, this.#roots, this.#exists, holdIncomplete);
    let delta: string;
    if (next?.text.startsWith(this.#text)) {
      delta = next.text.slice(this.#text.length);
      this.#consumed = next.consumed;
    } else {
      // Published text cannot be retracted, so continue with the native text verbatim.
      this.#verbatim = true;
      delta = this.#native.slice(this.#consumed);
      this.#consumed = this.#native.length;
    }
    this.#text += delta;
    return delta;
  }
}

interface LocalMediaProjection {
  readonly text: string;
  /** Length of the native text the projection covers. */
  readonly consumed: number;
}

function projectLocalMedia(
  text: string,
  roots: readonly string[],
  exists: LocalMediaExists,
  holdIncomplete: boolean,
): LocalMediaProjection {
  let output = "";
  let index = 0;
  let fence: { readonly marker: string; readonly length: number } | null = null;
  while (index < text.length) {
    if (fence) {
      // Fenced code is copied verbatim through its closing fence line.
      const close = closingFenceEnd(text, index, fence.marker, fence.length);
      if (close === -1) break;
      output += text.slice(index, close);
      index = close;
      fence = null;
      continue;
    }
    const next = earliestIndex([
      text.indexOf("![", index),
      text.indexOf("`", index),
      indexOfLineStartTilde(text, index),
    ]);
    if (next === -1) break;
    output += text.slice(index, next);
    index = next;
    const marker = text[next];
    if (marker === "`" || marker === "~") {
      let runEnd = next;
      while (text[runEnd] === marker) runEnd += 1;
      if (runEnd === text.length && holdIncomplete) {
        // The run may still grow into a fence, or a backtick may open a media path.
        return { text: output, consumed: next };
      }
      if (runEnd - next >= 3) {
        const kind = fenceLineKind(text, next);
        // Container nesting/indentation is not reconstructed. Keep the rest of the message
        // verbatim rather than risk rewriting code after an uncertain closing boundary.
        if (kind === "opaque") break;
        if (kind === "flat") {
          fence = { marker, length: runEnd - next };
          output += text.slice(next, runEnd);
          index = runEnd;
          continue;
        }
      }
      if (marker === "~" || runEnd - next > 1) {
        output += text.slice(next, runEnd);
        index = runEnd;
        continue;
      }
    }
    if (text.startsWith("![", next)) {
      const image = parseMarkdownImage(text, next);
      if (image.kind === "text") {
        output += text.slice(next, image.end);
        index = image.end;
        continue;
      }
      if (image.kind === "open") {
        if (!holdIncomplete) break;
        return { text: output + text.slice(next, image.holdFrom), consumed: image.holdFrom };
      }
      const resolved = resolveLocalMediaPath(image.destination, roots, exists);
      output +=
        resolved === null
          ? text.slice(next, image.end)
          : text.slice(next, image.destinationStart) +
            markdownDestination(resolved, image.bracketed) +
            text.slice(image.destinationEnd, image.end);
      index = image.end;
      continue;
    }
    const code = parseInlineCode(text, next);
    if (code.kind === "text") {
      output += "`";
      index = next + 1;
      continue;
    }
    if (code.kind === "open") {
      if (!holdIncomplete) break;
      return { text: output, consumed: next };
    }
    const resolved = resolveLocalMediaPath(code.content, roots, exists);
    output += resolved === null ? text.slice(next, code.end) : mediaMarkdownImage(resolved);
    index = code.end;
  }
  return { text: output + text.slice(index), consumed: text.length };
}

/** Only unprefixed openers are unambiguously flat without reconstructing list nesting. */
function fenceLineKind(text: string, index: number): "flat" | "opaque" | null {
  const prefix = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
  if (prefix === "") return "flat";
  let remaining = prefix.replace(/^[ \t]+/u, "");
  while (remaining) {
    const marker = /^(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]))[ \t]*/u.exec(remaining);
    if (!marker) return null;
    remaining = remaining.slice(marker[0].length);
  }
  return "opaque";
}

/** A `~` that could open a fence; elsewhere tildes are ordinary text. */
function indexOfLineStartTilde(text: string, start: number): number {
  for (let tilde = text.indexOf("~", start); tilde !== -1; tilde = text.indexOf("~", tilde + 1)) {
    if (fenceLineKind(text, tilde) !== null) return tilde;
  }
  return -1;
}

/**
 * End of the line that closes a fence opened before `start`: the same marker, at least as long,
 * indented at most three spaces and followed only by spaces or tabs (and the `\r` of a CRLF line
 * ending). -1 while still inside.
 */
function closingFenceEnd(text: string, start: number, marker: string, length: number): number {
  const closing = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${length},}[ \\t]*\\r?$`, "u");
  // The opening line's info string is never a closing fence.
  let lineStart = text.indexOf("\n", start);
  while (lineStart !== -1) {
    lineStart += 1;
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (closing.test(text.slice(lineStart, lineEnd))) return lineEnd;
    lineStart = newline;
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

/** `text`: ordinary text through `end`. `open`: the text ends before the construct is decided. */
type ParsedInlineCode =
  { kind: "code"; content: string; end: number } | { kind: "open" } | { kind: "text" };

function parseInlineCode(text: string, start: number): ParsedInlineCode {
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    // A path never spans lines, so leave the tick as text rather than hold everything after it.
    if (character === "\n") return { kind: "text" };
    if (character === "`") {
      return { kind: "code", content: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return { kind: "open" };
}

type ParsedMarkdownImage =
  | {
      kind: "image";
      destination: string;
      destinationStart: number;
      destinationEnd: number;
      end: number;
      bracketed: boolean;
    }
  /** Published text may end at `holdFrom`; only later text can decide the rest. */
  | { kind: "open"; holdFrom: number }
  | { kind: "text"; end: number };

/** Parses a single-line `![label](destination)` with an optional title. */
function parseMarkdownImage(text: string, start: number): ParsedMarkdownImage {
  // Until the label closes, only `![` is settled: `!` was publishable before `[` arrived.
  const openLabel = { kind: "open", holdFrom: start + 2 } as const;
  let index = start + 2;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n") return { kind: "text", end: start + 1 };
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "]") break;
    index += 1;
  }
  if (index + 1 >= text.length) return openLabel;
  if (text[index + 1] !== "(") return { kind: "text", end: start + 1 };
  const destinationStart = index + 2;
  // From here `![label](` is settled; a malformed rest leaves it, and the label, as text.
  const open = { kind: "open", holdFrom: destinationStart } as const;
  const malformed = { kind: "text", end: destinationStart } as const;
  index = skipBlanks(text, destinationStart);
  if (index >= text.length) return open;
  let destination: string;
  let destinationEnd: number;
  let bracketed = false;
  if (text[index] === "<") {
    bracketed = true;
    let close = index + 1;
    while (close < text.length && text[close] !== ">" && text[close] !== "\n") close += 1;
    if (close >= text.length) return open;
    if (text[close] === "\n") return malformed;
    destination = text.slice(index + 1, close);
    destinationEnd = close + 1;
    index = destinationEnd;
  } else {
    const begin = index;
    while (index < text.length) {
      const character = text[index];
      if (character === "\n" || character === " " || character === "\t" || character === ")") break;
      index += character === "\\" ? 2 : 1;
    }
    if (index >= text.length) return open;
    destination = unescapeMarkdown(text.slice(begin, index));
    destinationEnd = index;
  }
  index = skipBlanks(text, index);
  if (index >= text.length) return open;
  const opener = text[index];
  if (opener === '"' || opener === "'" || opener === "(") {
    const closer = opener === "(" ? ")" : opener;
    index += 1;
    while (index < text.length && text[index] !== closer && text[index] !== "\n") index += 1;
    if (index >= text.length) return open;
    if (text[index] === "\n") return malformed;
    index = skipBlanks(text, index + 1);
    if (index >= text.length) return open;
  }
  if (text[index] !== ")") return malformed;
  return {
    kind: "image",
    destination,
    destinationStart,
    destinationEnd,
    end: index + 1,
    bracketed,
  };
}

function skipBlanks(text: string, start: number): number {
  let index = start;
  while (text[index] === " " || text[index] === "\t") index += 1;
  return index;
}

function mediaMarkdownImage(absolutePath: string): string {
  const name = path.basename(absolutePath).replaceAll("]", "\\]");
  return `![${name}](${markdownDestination(absolutePath, false)})`;
}

function markdownDestination(absolutePath: string, bracketed: boolean): string {
  // CommonMark drops a backslash before punctuation (`C:\Users\me\.codex`), and Codex reads
  // `C:/…` as absolute; other paths keep their backslashes escaped.
  // Both Desktop's Markdown token conversion and media loader decode the local path once.
  // Encode only the resolved filesystem path, never a file: URL's own URI escapes.
  const encoded = absolutePath.replaceAll("%", "%2525");
  const destination = /^[A-Za-z]:\\/.test(encoded)
    ? encoded.replaceAll("\\", "/")
    : encoded.replaceAll("\\", "\\\\");
  return bracketed || /[\s()]/.test(destination) ? `<${destination}>` : destination;
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\()])/g, "$1");
}

/** Resolve a media reference to an existing absolute file, trying relative paths under `roots`. */
export function resolveLocalMediaPath(
  raw: string,
  roots: readonly string[],
  exists: LocalMediaExists = mediaFileExists,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isRemoteMediaUrl(trimmed)) return null;
  const stripped = stripFileUrl(trimmed);
  if (stripped === null) return null;
  if (isAbsoluteMediaPath(stripped)) {
    const absolute = path.resolve(stripped);
    return hasMediaExtension(absolute) && exists(absolute) ? absolute : null;
  }
  for (const root of roots) {
    const absolute = path.resolve(root, stripped);
    if (hasMediaExtension(absolute) && exists(absolute)) return absolute;
  }
  return null;
}

function isRemoteMediaUrl(value: string): boolean {
  return /^(?:https?:|data:|app:|blob:)/i.test(value);
}

function stripFileUrl(value: string): string | null {
  if (!value.toLowerCase().startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return null;
  }
}

function isAbsoluteMediaPath(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

function hasMediaExtension(value: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function mediaFileExists(absolutePath: string): boolean {
  try {
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
