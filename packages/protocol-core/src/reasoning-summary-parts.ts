/**
 * Codex previews the newest Reasoning summary part, and GPT parts open with a
 * bold title line. Host Reasoning text is split the same way: one part per
 * paragraph, with an untitled paragraph's first sentence lifted into its title.
 * Once the Harness writes its own `**Title**` paragraphs, untitled paragraphs
 * stay in the latest titled part instead.
 */

const FENCE = /^(?:`{3,}|~{3,})/u;
/** An open paragraph that may still become a title or a code fence. */
const UNDECIDED = /^(?:\*|`{1,2}|~{1,2})$/u;
const BLOCK_MARKER = /^(?:[-*+]|\d{1,9}[.)]|#{1,6}|>)[ \t]+/u;
const SENTENCE_END = /[.!?](?=\s)|[。！？]|\n/gu;
/** A "." after a lone number, a single letter or a dotted abbreviation ends no sentence. */
const ABBREVIATION = /(?:^|[\s([])(?:\d+|\p{L}|(?:\p{L}\.)+\p{L}|mrs?|ms|dr|vs|cf)$/iu;
const KEPT_TERMINATOR = /^[!?！？]$/u;
/** Per UTF-16 unit; a surrogate pair therefore counts 2 like other wide characters. */
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
/** Title budget in display columns. */
const TITLE_MAX = 60;

/**
 * Splits displayed Reasoning text into Codex summary parts.
 *
 * With `complete` false the text may still grow, so only output that later
 * appends cannot change is returned: every returned part is a prefix of the
 * same part computed from any longer text. Live deltas and the completed
 * Item therefore agree, and history projection reproduces the same parts.
 */
export function reasoningSummaryParts(text: string, complete: boolean): string[] {
  const paragraphs = splitParagraphs(text);
  const parts: string[] = [];
  let titled = false;
  for (const [index, raw] of paragraphs.entries()) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    const open = !complete && index === paragraphs.length - 1;
    if (open && UNDECIDED.test(paragraph)) break;
    if (paragraph.startsWith("**")) {
      parts.push(paragraph);
      titled = true;
    } else if (parts.length > 0 && (titled || FENCE.test(paragraph))) {
      // Body of a Harness-titled part, or a code block continuing the previous part.
      parts[parts.length - 1] += `\n\n${paragraph}`;
    } else {
      const part = synthesizedPart(paragraph, open);
      if (part === undefined) break;
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Splits on blank lines outside code fences. Only complete lines decide a
 * split, so appended text never moves an earlier boundary.
 */
function splitParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const last = lines.pop() ?? "";
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence === undefined && !trimmed) {
      paragraphs.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
    const marker = FENCE.exec(trimmed)?.[0];
    if (fence === undefined) fence = marker;
    else if (marker === trimmed && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = undefined;
    }
  }
  current.push(last);
  paragraphs.push(current.join("\n"));
  return paragraphs;
}

/** Returns undefined while an open paragraph's title cannot be decided yet. */
function synthesizedPart(paragraph: string, open: boolean): string | undefined {
  // A code block keeps its fence line intact; it never becomes a title.
  if (FENCE.test(paragraph)) return paragraph;
  const stripped = paragraph.replace(BLOCK_MARKER, "");
  // A closed paragraph ends its first sentence at the latest.
  const source = open ? stripped : `${stripped}\n`;
  const end = sentenceEnd(source);
  if (end && width(source.slice(0, end.index)) <= TITLE_MAX) {
    const title = cleanTitle(
      source.slice(0, end.index) + (KEPT_TERMINATOR.test(end[0]) ? end[0] : ""),
    );
    if (!title) return paragraph;
    const body = source.slice(end.index + end[0].length).trim();
    return body ? `**${title}**\n\n${body}` : `**${title}**`;
  }
  // A later sentence end sits at or after the last character; hold while it could still fit.
  if (!end && width(source.slice(0, -1)) <= TITLE_MAX) return undefined;
  const title = cleanTitle(truncatedTitle(source));
  return title ? `**${title}…**\n\n${paragraph}` : paragraph;
}

function sentenceEnd(source: string): RegExpExecArray | undefined {
  for (const match of source.matchAll(SENTENCE_END)) {
    if (match[0] === "." && ABBREVIATION.test(source.slice(0, match.index))) continue;
    return match;
  }
  return undefined;
}

function width(text: string): number {
  let columns = 0;
  for (let index = 0; index < text.length; index += 1) {
    columns += WIDE.test(text.charAt(index)) ? 2 : 1;
  }
  return columns;
}

function truncatedTitle(source: string): string {
  let cut = 0;
  let columns = 0;
  while (cut < source.length) {
    columns += WIDE.test(source.charAt(cut)) ? 2 : 1;
    if (columns > TITLE_MAX) break;
    cut += 1;
  }
  const space = source.lastIndexOf(" ", cut - 1);
  if (space > 0 && width(source.slice(0, space)) >= TITLE_MAX / 2) cut = space;
  const last = source.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return source.slice(0, cut);
}

function cleanTitle(title: string): string {
  return title.replaceAll("*", "").trim();
}
