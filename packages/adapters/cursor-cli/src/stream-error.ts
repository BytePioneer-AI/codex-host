// Adapted from liki-0814/codex-host commit 43eefce5 (LGPL-3.0).
/** Native Cursor ACP can stream an internal teardown as text, then report end_turn. */
const CLOSED_ERROR =
  /(?:^|\n\n)Error:\s*(?:(?:RetriableError|T):)?\s*WritableIterable is closed\s*$/u;

const CLOSED_PREFIXES = [
  "\n\nError: RetriableError: WritableIterable is closed",
  "\n\nError: T: WritableIterable is closed",
  "\n\nError: WritableIterable is closed",
  "Error: RetriableError: WritableIterable is closed",
  "Error: T: WritableIterable is closed",
  "Error: WritableIterable is closed",
];
const LONGEST_PREFIX = Math.max(...CLOSED_PREFIXES.map((prefix) => prefix.length));

export function isCursorWritableIterableClosed(message: string): boolean {
  return /WritableIterable is closed/iu.test(message);
}

export function takeCursorWritableIterableClosed(
  text: string,
  atMessageStart = true,
): {
  visible: string;
  closed: boolean;
} {
  const match = text.match(CLOSED_ERROR);
  if (
    !match ||
    match.index === undefined ||
    (match.index === 0 && !text.startsWith("\n\n") && !atMessageStart)
  )
    return { visible: text, closed: false };
  return { visible: text.slice(0, match.index), closed: true };
}

export function holdCursorWritableIterablePrefix(
  text: string,
  atMessageStart = true,
): { emit: string; hold: string } {
  const taken = takeCursorWritableIterableClosed(text, atMessageStart);
  // Keep a complete candidate until the native terminal. A later chunk may
  // continue an ordinary explanation containing these words.
  if (taken.closed) return { emit: taken.visible, hold: text.slice(taken.visible.length) };
  for (let size = Math.min(text.length, LONGEST_PREFIX); size > 0; size -= 1) {
    const suffix = text.slice(-size);
    const start = text.length - size;
    if (
      !suffix.startsWith("\n") &&
      !(start === 0 && atMessageStart) &&
      text.slice(Math.max(0, start - 2), start) !== "\n\n"
    )
      continue;
    if (CLOSED_PREFIXES.some((candidate) => candidate.startsWith(suffix))) {
      return { emit: text.slice(0, -size), hold: suffix };
    }
  }
  return { emit: text, hold: "" };
}
