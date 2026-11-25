import { harnessCommandReferences, skillReferences } from "@codexhost/shared-contracts";

/** Sentence punctuation a bare `@name` token may carry without being part of the reference. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？]+$/u;

const HARNESS_URI_PREFIX = "subagent://codexhost.";
const THREAD_ANCHOR = "](thread://";
const DSH_SESSION_ANCHOR = "](dsh-session:";

export interface UserTextRange {
  readonly start: number;
  readonly end: number;
  /** Matched source text (hover title). */
  readonly label: string;
  readonly kind: "session" | "harness" | "command" | "plain" | "skill";
  /** Pre-resolved display text (wire folds); derived from label when absent. */
  readonly display?: string;
}

interface RankedRange extends UserTextRange {
  readonly priority: number;
}

function isEscaped(text: string, index: number, floor: number): boolean {
  let backslashes = 0;
  for (let pos = index - 1; pos >= floor && text[pos] === "\\"; pos--) backslashes++;
  return backslashes % 2 === 1;
}

/**
 * Anchor-based linear scanner for explicit Harness delegation links
 * `[@Label](subagent://codexhost.<id>)` (or angle-bracketed URI).
 */
function scanHarnessMentions(text: string): RankedRange[] {
  if (!text.includes(HARNESS_URI_PREFIX)) return [];
  const results: RankedRange[] = [];
  let searchFrom = 0;
  let floor = 0;
  while (searchFrom < text.length) {
    const prefixStart = text.indexOf(HARNESS_URI_PREFIX, searchFrom);
    if (prefixStart === -1) break;
    let angleWrapped = false;
    let closeBracket = -1;
    if (prefixStart >= 2 && text[prefixStart - 1] === "(" && text[prefixStart - 2] === "]") {
      closeBracket = prefixStart - 2;
    } else if (
      prefixStart >= 3 &&
      text[prefixStart - 1] === "<" &&
      text[prefixStart - 2] === "(" &&
      text[prefixStart - 3] === "]"
    ) {
      angleWrapped = true;
      closeBracket = prefixStart - 3;
    }
    if (closeBracket < floor) {
      searchFrom = prefixStart + HARNESS_URI_PREFIX.length;
      continue;
    }
    const idStart = prefixStart + HARNESS_URI_PREFIX.length;
    let cursor = idStart;
    if (cursor < text.length && /^[a-z0-9]$/u.test(text[cursor]!)) {
      cursor++;
      while (cursor < text.length && /^[a-z0-9-]$/u.test(text[cursor]!)) cursor++;
    }
    const end =
      cursor > idStart
        ? angleWrapped
          ? text[cursor] === ">" && text[cursor + 1] === ")"
            ? cursor + 2
            : -1
          : text[cursor] === ")"
            ? cursor + 1
            : -1
        : -1;
    if (end === -1) {
      floor = closeBracket + 1;
      searchFrom = prefixStart + HARNESS_URI_PREFIX.length;
      continue;
    }
    let start = -1;
    for (let i = closeBracket - 1; i >= floor; i--) {
      const ch = text[i]!;
      if (ch === "\n" || ch === "\r" || ch === "]") break;
      if (ch === "[" && text[i + 1] === "@") {
        start = i;
        break;
      }
    }
    if (start !== -1 && start + 2 < closeBracket) {
      const label = text.slice(start, end);
      results.push({
        start,
        end,
        label,
        kind: "harness",
        display: text.slice(start + 2, closeBracket).trim(),
        priority: 0,
      });
      floor = end;
      searchFrom = end;
    } else {
      floor = closeBracket + 1;
      searchFrom = prefixStart + HARNESS_URI_PREFIX.length;
    }
  }
  return results;
}

/**
 * Anchor-based linear scanner for explicit CH thread mentions
 * `[@Label](thread://<id>?hostId=<hostId>)`. Scanning backward from `](thread://`
 * to the previous `]` keeps worst-case time O(n) even on repeated `\[@` prefixes.
 */
function scanThreadMentions(text: string): RankedRange[] {
  if (!text.includes(THREAD_ANCHOR)) return [];
  const results: RankedRange[] = [];
  let searchFrom = 0;
  let floor = 0;
  while (searchFrom < text.length) {
    const closeBracket = text.indexOf(THREAD_ANCHOR, searchFrom);
    if (closeBracket === -1) break;
    const nextSearch = closeBracket + THREAD_ANCHOR.length;
    if (closeBracket < floor || isEscaped(text, closeBracket, floor)) {
      searchFrom = nextSearch;
      continue;
    }
    let cursor = nextSearch;
    const idStart = cursor;
    while (cursor < text.length && !/[/?#()[\]\s<>]/u.test(text[cursor]!)) cursor++;
    if (cursor === idStart || !text.startsWith("?hostId=", cursor)) {
      floor = closeBracket + 1;
      searchFrom = Math.max(nextSearch, cursor);
      continue;
    }
    cursor += "?hostId=".length;
    const hostStart = cursor;
    while (cursor < text.length && !/[&#()[\]\s<>]/u.test(text[cursor]!)) cursor++;
    if (cursor === hostStart || text[cursor] !== ")") {
      floor = closeBracket + 1;
      searchFrom = Math.max(nextSearch, cursor);
      continue;
    }
    const end = cursor + 1;
    let start = -1;
    for (let i = closeBracket - 1; i >= floor; i--) {
      const ch = text[i]!;
      if (ch === "\n" || ch === "\r") break;
      if (ch === "]" && !isEscaped(text, i, floor)) break;
      if (ch === "[" && text[i + 1] === "@" && !isEscaped(text, i, floor)) {
        start = i;
        break;
      }
    }
    if (start !== -1 && start + 2 < closeBracket) {
      const label = text.slice(start, end);
      const rawDisplay = text.slice(start + 2, closeBracket);
      results.push({
        start,
        end,
        label,
        kind: "session",
        display: rawDisplay.replace(/\\([\\`*{}[\]()#+.!_<>|~-])/gu, "$1"),
        priority: 0,
      });
      floor = end;
      searchFrom = end;
    } else {
      floor = closeBracket + 1;
      searchFrom = nextSearch;
    }
  }
  return results;
}

/**
 * Anchor-based linear scanner for DSH session mentions `@[Label](dsh-session:<id>)`.
 * Preserves literal `[` and `@[` characters inside DSH session titles (matching
 * `formatSessionReferenceMention` / `parseSessionReferenceText`) while scanning
 * each URI payload character at most once even when `)` is missing.
 */
function scanDshSessionMentions(text: string): RankedRange[] {
  if (!text.includes(DSH_SESSION_ANCHOR)) return [];
  const results: RankedRange[] = [];
  let searchFrom = 0;
  let floor = 0;
  while (searchFrom < text.length) {
    const closeBracket = text.indexOf(DSH_SESSION_ANCHOR, searchFrom);
    if (closeBracket === -1) break;
    const nextSearch = closeBracket + DSH_SESSION_ANCHOR.length;
    if (closeBracket < floor || isEscaped(text, closeBracket, floor)) {
      searchFrom = nextSearch;
      continue;
    }
    let cursor = nextSearch;
    // Canonical DSH session payloads are base64url (`[A-Za-z0-9_-]+`); stop at
    // whitespace, brackets, parens, angle brackets, or control characters so a
    // missing `)` never rescans subsequent anchors.
    while (cursor < text.length && !/[\s()[\]<>\u0000-\u001f\u007f]/u.test(text[cursor]!)) cursor++;
    if (cursor === nextSearch || text[cursor] !== ")") {
      floor = closeBracket + 1;
      searchFrom = Math.max(nextSearch, cursor);
      continue;
    }
    const end = cursor + 1;
    // Walk backward to the leftmost `@[` on this line/segment so labels with
    // literal `[` or `@[` (e.g. `Release @[draft`) keep their full text.
    let start = -1;
    for (let i = closeBracket - 1; i >= floor; i--) {
      const ch = text[i]!;
      if (ch === "\n") break;
      if (ch === "]" && !isEscaped(text, i, floor)) break;
      if (ch === "[" && i > floor && text[i - 1] === "@") {
        start = i - 1;
      }
    }
    if (start !== -1 && start + 2 < closeBracket) {
      const label = text.slice(start, end);
      results.push({
        start,
        end,
        label,
        kind: "session",
        display: text.slice(start + 2, closeBracket).replace(/\\(.)/gu, "$1"),
        priority: 0,
      });
      floor = end;
      searchFrom = end;
    } else {
      floor = closeBracket + 1;
      searchFrom = Math.max(nextSearch, cursor);
    }
  }
  return results;
}

/**
 * Resolve non-overlapping decoration ranges for sent user text. Explicit wire
 * carriers (skill, command, harness, thread, session) are resolved first so a
 * preceding plain `@` token cannot swallow an adjacent explicit reference;
 * plain `@` and `/` tokens are only scanned within the uncovered text slices.
 */
export function planUserTextRanges(
  text: string,
  sessionLabels: readonly string[],
  slashNames: readonly string[] = [],
): UserTextRange[] {
  const explicit: RankedRange[] = skillReferences(text).map((ref) => ({
    start: ref.start,
    end: ref.end,
    label: ref.text,
    kind: "skill",
    display: ref.name,
    priority: 0,
  }));
  for (const ref of harnessCommandReferences(text)) {
    explicit.push({
      start: ref.start,
      end: ref.end,
      label: ref.invocation,
      kind: "command",
      display: ref.invocation,
      priority: 0,
    });
  }
  explicit.push(
    ...scanHarnessMentions(text),
    ...scanThreadMentions(text),
    ...scanDshSessionMentions(text),
  );
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`;
    let start = text.indexOf(label);
    while (start >= 0) {
      explicit.push({ start, end: start + label.length, label, kind: "session", priority: 1 });
      start = text.indexOf(label, start + label.length);
    }
  }

  explicit.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
  const resolvedExplicit: UserTextRange[] = [];
  let cursor = 0;
  for (const { priority: _priority, ...range } of explicit) {
    if (range.start < cursor) continue;
    resolvedExplicit.push(range);
    cursor = range.end;
  }

  const gaps: Array<{ start: number; end: number }> = [];
  let gapCursor = 0;
  for (const range of resolvedExplicit) {
    if (range.start > gapCursor) gaps.push({ start: gapCursor, end: range.start });
    gapCursor = range.end;
  }
  if (gapCursor < text.length) gaps.push({ start: gapCursor, end: text.length });

  // Scan plain `/` and `@` tokens only within slices not owned by explicit
  // references; `/` tokens stay whitespace-bounded against the full text.
  const plainRanges: UserTextRange[] = [];
  const plainTokenRe = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu;
  for (const gap of gaps) {
    const slice = text.slice(gap.start, gap.end);
    plainTokenRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = plainTokenRe.exec(slice)) !== null) {
      const prefix = m[1] as string;
      const tokenStart = gap.start + m.index + prefix.length;
      // When the token sits at the start of a slice immediately after an
      // explicit reference, require whitespace in the full text before it.
      if (prefix === "" && tokenStart > 0 && !/\s/u.test(text[tokenStart - 1] ?? "")) continue;
      const rawLabel = m[2] as string;
      const label = rawLabel.startsWith('@"')
        ? rawLabel
        : rawLabel.replace(TRAILING_PUNCTUATION_RE, "");
      if (label.length <= 1) continue;
      const tokenEnd = tokenStart + label.length;
      if (label.startsWith("/")) {
        if (!slashNames.includes(label.slice(1))) continue;
        if (tokenEnd < text.length && !/\s/u.test(text[tokenEnd] ?? "")) continue;
      }
      plainRanges.push({ start: tokenStart, end: tokenEnd, label, kind: "plain" });
    }
  }

  return [...resolvedExplicit, ...plainRanges].sort((a, b) => a.start - b.start);
}
