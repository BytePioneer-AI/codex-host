/**
 * Browser-safe `@file` token grammar shared by terminal and web clients.
 *
 * @module @deepseek-ai/dsh-file-reference/grammar
 */

import type { FileReferenceCandidate } from "./types.ts";

/** Active `@` token ending at the editor cursor. */
export interface ActiveAtToken {
  /** Complete token replaced when the user accepts a completion. */
  prefix: string;
  /** Path query after `@` or `@"`. */
  query: string;
  /** Whether the user opened a quoted path. */
  quoted: boolean;
}

/**
 * Characters after which the `#` alias opens: whitespace, CJK ideographs, kana,
 * the prolonged sound mark and CJK or fullwidth punctuation, because Chinese
 * and Japanese text has no spaces between words. Latin words, digits, URLs and
 * entities keep `#` as text; Hangul uses spaces, like Latin text. The Desktop
 * Composer applies the same boundary in `renderer-reference-trigger.ts`.
 */
const HASH_BOUNDARY = String.raw`[\s\p{sc=Han}\p{sc=Hira}\p{sc=Kana}\u30FC\u3000-\u303F\uFF01\uFF02\uFF04-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]`;
const HASH_QUOTED = new RegExp(String.raw`(?:^|${HASH_BOUNDARY})([#\uFF03]"([^"]*))$`, "u");
const HASH_PLAIN = new RegExp(String.raw`(?:^|${HASH_BOUNDARY})([#\uFF03]([^\s]*))$`, "u");

/**
 * Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
 * inside another token, such as an email address, is not a completion trigger.
 * @param line - current editor line.
 * @param cursorCol - cursor column within that line.
 * @param trigger - the reference-menu prefix; hash (or fullwidth `＃`) is an
 * equivalent UI alias that also opens after CJK text and punctuation.
 * @returns the active token, or `undefined` outside a reference token.
 */
export function activeAtToken(
  line: string,
  cursorCol: number,
  trigger: "@" | "#" = "@",
): ActiveAtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol);
  const quoted = (trigger === "@" ? /(?:^|\s)(@"([^"]*))$/u : HASH_QUOTED).exec(beforeCursor);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true };
  }
  const plain = (trigger === "@" ? /(?:^|\s)(@([^\s]*))$/u : HASH_PLAIN).exec(beforeCursor);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false };
}

/**
 * Format a selected path as prompt text. Whitespace uses the quoted
 * `@"path"` grammar; a quoted directory keeps that quote open after its
 * trailing slash so completion can descend another level.
 * @param candidate - selected file or directory.
 * @param preserveQuote - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
 */
export function formatFileMention(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
): string | undefined {
  const path = candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  const quoted = preserveQuote || /\s/u.test(path);
  if (!quoted) return `@${path}`;
  if (candidate.kind === "directory") return `@"${path}`;
  return `@"${path}"`;
}
