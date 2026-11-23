/**
 * Boundary and code-context rules for the Composer `#` trigger.
 *
 * Chinese and Japanese text has no spaces between words, so `#` also opens
 * after CJK ideographs, kana, the prolonged sound mark and CJK or fullwidth
 * punctuation. Latin words, digits, URLs and entities (`C#`, `issue#12`,
 * `/#anchor`, `&#39;`) keep `#` as text. Hangul is excluded because Korean
 * separates words with spaces, like Latin text. The Web Composer applies the
 * same boundary and Markdown code rules in
 * `apps/web-ui/packages/client/ui-input-trigger/src/core/detect.ts`.
 */
export const HASH_BOUNDARY = String.raw`[\s\p{sc=Han}\p{sc=Hira}\p{sc=Kana}\u30FC\u3000-\u303F\uFF01\uFF02\uFF04-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]`;

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

function isFenceOpening(marker: string, rest: string): boolean {
  // CommonMark §4.5: backtick fence info strings cannot contain backticks.
  return marker === "~" || !rest.includes("`");
}

/**
 * Whether the caret, at the end of `textBeforeCaret`, is inside Markdown code:
 * an unclosed fenced block, the opening line of a fence, or an unclosed inline
 * code span within the current paragraph (reset on blank lines and fences,
 * skipping backslash-escaped backticks outside code spans). Only text before
 * the caret is read.
 */
export function insideMarkdownCode(textBeforeCaret: string): boolean {
  const lines = textBeforeCaret.split(/\r\n|\n|\r/u);
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
