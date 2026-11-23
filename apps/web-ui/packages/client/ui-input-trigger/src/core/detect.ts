/**
 * Trigger detection pure core. Scans backward from
 * the caret for a live trigger char under the guard tier and applies the
 * word-boundary rules. Zero React / DOM / cordis.
 */
import { activeAtToken } from "@deepseek-ai/dsh-file-reference/grammar";
import type { TriggerChar } from "../types.ts";
import type { DetectTrigger } from "./contract.ts";

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/**
 * Whether the caret, at the end of `beforeCaret`, is inside Markdown code: an
 * unclosed fenced block, the opening line of a fence, or an unclosed inline
 * code span on the current line. The Desktop Composer keeps the same rule in
 * `renderer-reference-trigger.ts`.
 */
function insideMarkdownCode(beforeCaret: string): boolean {
  const lines = beforeCaret.split(/\r\n|\n|\r/u);
  const current = lines.pop() ?? "";
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line);
    if (!match) continue;
    const run = match[1] ?? "";
    if (fence === null) fence = { marker: run.charAt(0), length: run.length };
    else if (
      run.charAt(0) === fence.marker &&
      run.length >= fence.length &&
      (match[2] ?? "").trim() === ""
    ) {
      fence = null;
    }
  }
  if (fence !== null || FENCE_PATTERN.test(current)) return true;
  // An inline code span closes on a backtick run of the same length.
  let open = 0;
  for (const [run] of current.matchAll(/`+/gu)) {
    if (open === 0) open = run.length;
    else if (run.length === open) open = 0;
  }
  return open > 0;
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
 * Detect a trigger token at the caret. `@` and `#` use the same reference grammar,
 * including an open quoted token that may span whitespace; `#` (or fullwidth
 * `＃`) also opens after CJK text and punctuation, and stays text inside
 * Markdown code. Slash detection
 * scans left to the first whitespace; slashes failing the word boundary are
 * treated as ordinary token chars and the scan continues (URL slashes).
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
    const token = activeAtToken(draft, caret, trigger);
    if (token === undefined) continue;
    const start = caret - token.prefix.length;
    // A quoted path may contain spaces followed by the other trigger character.
    if (reference !== null && reference.span.start <= start) continue;
    // A `#` token inside Markdown code is code text; a slash within it is no command either.
    if (trigger === "#" && insideMarkdownCode(draft.slice(0, start))) return reference;
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
