/**
 * Boundary and code-context rules for the Composer `#` trigger.
 *
 * Chinese and Japanese text has no spaces between words, so `#` also opens
 * after CJK ideographs, kana, the prolonged sound mark and CJK or fullwidth
 * punctuation. Latin words, digits, URLs and entities (`C#`, `issue#12`,
 * `/#anchor`, `&#39;`) keep `#` as text. Hangul is excluded because Korean
 * separates words with spaces, like Latin text. The Web Composer applies the
 * same boundary in `@deepseek-ai/dsh-file-reference/grammar`.
 */
export const HASH_BOUNDARY = String.raw`[\s\p{sc=Han}\p{sc=Hira}\p{sc=Kana}\u30FC\u3000-\u303F\uFF01\uFF02\uFF04-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]`;

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;

/**
 * Whether the caret, at the end of `textBeforeCaret`, is inside Markdown code:
 * an unclosed fenced block, the opening line of a fence, or an unclosed
 * inline code span on the current line. Only text before the caret is read.
 */
export function insideMarkdownCode(textBeforeCaret: string): boolean {
  const lines = textBeforeCaret.split(/\r\n|\n|\r/u);
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
