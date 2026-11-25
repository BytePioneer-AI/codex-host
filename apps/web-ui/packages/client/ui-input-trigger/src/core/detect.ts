/**
 * Trigger detection pure core. Scans backward from
 * the caret for a live trigger char under the guard tier and applies the
 * word-boundary rules. Zero React / DOM / cordis.
 */
import { activeAtToken, type ActiveAtToken } from "@deepseek-ai/dsh-file-reference/grammar";
import type { TriggerChar } from "../types.ts";
import type { DetectTrigger } from "./contract.ts";

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

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

function activeHashToken(draft: string, caret: number): ActiveAtToken | undefined {
  const beforeCaret = draft.slice(0, caret);
  const quoted = HASH_QUOTED.exec(beforeCaret);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true };
  }
  const plain = HASH_PLAIN.exec(beforeCaret);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false };
}

function isFenceOpening(marker: string, rest: string): boolean {
  // CommonMark §4.5: backtick fence info strings cannot contain backticks.
  return marker === "~" || !rest.includes("`");
}

/**
 * Whether the caret, at the end of `beforeCaret`, is inside Markdown code: an
 * unclosed fenced block, the opening line of a fence, or an unclosed inline
 * code span within the current paragraph (reset on blank lines and fences,
 * skipping backslash-escaped backticks outside code spans). The Desktop
 * Composer keeps the same rule in `renderer-reference-trigger.ts`.
 */
function insideMarkdownCode(beforeCaret: string): boolean {
  const lines = beforeCaret.split(/\r\n|\n|\r/u);
  const lastIndex = lines.length - 1;
  let fence: { marker: string; length: number } | null = null;
  let inlineBackticks = 0;

  for (let lineIndex = 0; lineIndex <= lastIndex; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    if (fence !== null) {
      if (lineIndex < lastIndex) {
        const match = FENCE_PATTERN.exec(line);
        if (match) {
          const run = match[1] ?? "";
          if (
            run.charAt(0) === fence.marker &&
            run.length >= fence.length &&
            (match[2] ?? "").trim() === ""
          ) {
            fence = null;
          }
        }
      }
      continue;
    }

    // Completed blank lines end a paragraph and reset any unclosed inline code span.
    if (lineIndex < lastIndex && line.trim() === "") {
      inlineBackticks = 0;
      continue;
    }

    const match = FENCE_PATTERN.exec(line);
    if (match) {
      const run = match[1] ?? "";
      const marker = run.charAt(0);
      const rest = match[2] ?? "";
      if (isFenceOpening(marker, rest)) {
        inlineBackticks = 0;
        if (lineIndex === lastIndex) return true;
        fence = { marker, length: run.length };
        continue;
      }
    }

    // An inline code span closes on a backtick run of the same length; outside
    // a code span, backslash escapes the next character (including `\\` and `\``).
    let i = 0;
    while (i < line.length) {
      if (inlineBackticks === 0 && line.charAt(i) === "\\") {
        i += 2;
        continue;
      }
      if (line.charAt(i) === "`") {
        let end = i + 1;
        while (end < line.length && line.charAt(end) === "`") end += 1;
        const runLength = end - i;
        if (inlineBackticks === 0) inlineBackticks = runLength;
        else if (runLength === inlineBackticks) inlineBackticks = 0;
        i = end;
        continue;
      }
      i += 1;
    }
  }

  return fence !== null || inlineBackticks > 0;
}

/**
 * Word-boundary rule: a trigger char opens only at start-of-draft, after
 * whitespace (newlines included), or after punctuation. Two URL carve-outs
 * keep '/' dead inside URLs (both pinned by tests): '/' after a ':' that
 * itself follows a non-whitespace char (scheme separator, `https:/…`), and
 * '/' directly after another '/' (second slash of `//`).
 */
function boundaryOk(draft: string, index: number, char: TriggerChar): boolean {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (char === "/") {
    if (prev === "/") return false;
    if (prev === ":" && index >= 2 && !WHITESPACE.test(draft.charAt(index - 2))) return false;
  }
  return true;
}

/**
 * Detect a trigger token at the caret. `@` and `#` use the reference grammar,
 * including an open quoted token that may span whitespace; `#` (or fullwidth
 * `＃`) also opens after CJK text and punctuation while excluding consecutive
 * `#`/`＃` headings. Slash detection scans left to the first whitespace;
 * slashes failing the word boundary are treated as ordinary token chars and
 * the scan continues (URL slashes). All triggers stay text inside Markdown
 * fenced blocks and inline code spans.
 * Guard tiers: plain = all triggers live; claimed = '/' suppressed,
 * '@' and '#' live; frozen = none.
 *
 * @param draft - Full draft text.
 * @param caret - Caret offset into `draft`.
 * @param guard - Availability tier derived from the input phase.
 * @returns The hit with `query` = trigger-to-caret slice and `span` =
 * `{start: triggerIndex, end: caret}`; `span.draftRev` is a placeholder `0`
 * — the calling shell stamps the real revision. Null when no trigger is
 * live at the caret.
 */
export const detectTrigger: DetectTrigger = (draft, caret, guard) => {
  if (guard.tier === "frozen") return null;
  let reference: ReturnType<DetectTrigger> = null;
  for (const trigger of ["@", "#"] as const) {
    const token =
      trigger === "@" ? activeAtToken(draft, caret, "@") : activeHashToken(draft, caret);
    if (token === undefined) continue;
    const start = caret - token.prefix.length;
    // A quoted path may contain spaces followed by the other trigger character.
    if (reference !== null && reference.span.start <= start) continue;
    if (insideMarkdownCode(draft.slice(0, start))) continue;
    // Consecutive `#`/`＃` (such as Markdown `##` headings) stay plain text and
    // do not fall through to slash detection on `##/cmd`.
    if (trigger === "#" && !token.quoted && /[#\uFF03]/u.test(token.query)) return reference;
    reference = {
      trigger,
      query: token.query,
      quoted: token.quoted,
      position: draft.search(/\S/) === start ? "leading" : "inline",
      span: { start, end: caret, draftRev: 0 },
    };
  }
  if (reference !== null) return reference;
  const word = /(?:^|\s)(\S+)$/u.exec(draft.slice(0, caret))?.[1];
  if (word !== undefined && /^[a-z][a-z\d+.-]*:\/\//iu.test(word)) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== "/") continue;
    if (guard.tier === "claimed") continue;
    if (!boundaryOk(draft, i, ch)) continue;
    if (insideMarkdownCode(draft.slice(0, i))) continue;
    return {
      trigger: ch,
      query: draft.slice(i + 1, caret),
      quoted: false,
      position: draft.search(/\S/) === i ? "leading" : "inline",
      span: { start: i, end: caret, draftRev: 0 },
    };
  }
  return null;
};
