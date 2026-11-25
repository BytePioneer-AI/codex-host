/**
 * Delegation mention carrier shared by the Renderer `#` picker and the Host.
 *
 * The Renderer inserts Codex Desktop's native `agentMention` node, which
 * Desktop serializes into the prompt as a Markdown link. `subagent://` is the
 * scheme Desktop already restores and renders as an agent chip; the
 * `codexhost.` prefix keeps these targets apart from native custom agent
 * roles. The Host must rewrite every carrier before the prompt reaches a
 * Harness, so the raw link never leaks into a model turn.
 */
export const DELEGATION_MENTION_PATH_PREFIX = "subagent://codexhost.";

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const MENTION_LINK_PATTERN =
  /\[@([^\]\n]+)\]\(<?subagent:\/\/codexhost\.([a-z0-9][a-z0-9-]*)>?\)/gu;

export interface DelegationMention {
  harnessId: string;
  label: string;
}

export function delegationMentionPath(harnessId: string): string {
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    throw new Error(`Invalid delegation mention Harness id: ${harnessId}`);
  }
  return `${DELEGATION_MENTION_PATH_PREFIX}${harnessId}`;
}

function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[[\]()\n\r]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "agent";
}

/** Markdown carrier Desktop restores into a native agent mention chip. */
export function formatDelegationMentionLink(mention: DelegationMention): string {
  return `[@${sanitizeLabel(mention.label)}](${delegationMentionPath(mention.harnessId)})`;
}

export interface DelegationMentionRewrite {
  text: string;
  mentions: DelegationMention[];
}

/**
 * Replace each carrier link with its readable `@Label` form. Returns the
 * mentioned targets in first-seen order, without duplicates.
 */
export function stripDelegationMentions(text: string): DelegationMentionRewrite {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  const rewritten = text.replace(
    MENTION_LINK_PATTERN,
    (_match, label: string, harnessId: string) => {
      const trimmed = label.trim();
      if (!seen.has(harnessId)) {
        seen.add(harnessId);
        mentions.push({ harnessId, label: trimmed });
      }
      return `@${trimmed}`;
    },
  );
  return { text: rewritten, mentions };
}

/**
 * Harness command carrier. Selecting a command in the `#` menu inserts it as a
 * native agent mention chip instead of literal `/command` text, which would
 * open Desktop's own `/` menu. The Host restores it to a leading
 * invocation before native input routing or External Harness command matching.
 */
export const HARNESS_COMMAND_MENTION_PATH_PREFIX = "subagent://codexhost-command.";

export interface HarnessCommandReference {
  start: number;
  end: number;
  invocation: string;
  label: string;
  text: string;
}

export function harnessCommandMentionPath(invocation: string): string {
  const name = invocation.trim().replace(/^\//u, "");
  if (!name || /\s/u.test(name)) throw new Error(`Invalid Harness command: ${invocation}`);
  return `${HARNESS_COMMAND_MENTION_PATH_PREFIX}${encodeURIComponent(name).replace(
    /[()]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

function parseCommandReferenceAt(
  text: string,
  start: number,
  closeBracket: number,
): HarnessCommandReference | null {
  const rawLabel = text.slice(start + 2, closeBracket);
  if (!rawLabel || /[\r\n[\]]/u.test(rawLabel)) return null;
  if (text[closeBracket + 1] !== "(") return null;
  const uriStart = closeBracket + 2;
  const angleWrapped = text[uriStart] === "<";
  const prefixStart = angleWrapped ? uriStart + 1 : uriStart;
  if (!text.startsWith(HARNESS_COMMAND_MENTION_PATH_PREFIX, prefixStart)) return null;
  const encodedStart = prefixStart + HARNESS_COMMAND_MENTION_PATH_PREFIX.length;
  let cursor = encodedStart;
  while (cursor < text.length) {
    const ch = text[cursor]!;
    if (ch === ")" || ch === ">" || ch === "(" || ch === "<" || /\s/u.test(ch)) break;
    cursor++;
  }
  let end: number;
  if (angleWrapped) {
    if (text[cursor] !== ">" || text[cursor + 1] !== ")") return null;
    end = cursor + 2;
  } else {
    if (text[cursor] !== ")") return null;
    end = cursor + 1;
  }
  const encoded = text.slice(encodedStart, cursor);
  if (!encoded) return null;
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!name || name.startsWith("/") || /\s/u.test(name) || /[\u0000-\u001f\u007f]/u.test(name)) {
    return null;
  }
  const invocation = name.startsWith("$") ? name : `/${name}`;
  return {
    start,
    end,
    invocation,
    label: rawLabel.trim(),
    text: text.slice(start, end),
  };
}

/**
 * Extract validated Harness command carriers in linear time. Shared by both
 * display projection and submission restoration so syntax rules never diverge.
 */
export function harnessCommandReferences(text: string): HarnessCommandReference[] {
  const references: HarnessCommandReference[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("[@", pos);
    if (start === -1) break;
    const closeBracket = text.indexOf("]", start + 2);
    if (closeBracket === -1) break;
    const nested = text.lastIndexOf("[@", closeBracket - 1);
    if (nested > start) {
      pos = nested;
      continue;
    }
    const reference = parseCommandReferenceAt(text, start, closeBracket);
    if (reference) {
      references.push(reference);
      pos = reference.end;
    } else {
      pos = closeBracket + 1;
    }
  }
  return references;
}

/**
 * Move the first command carrier to the front as `/command` or `$skill`, keeping
 * the rest of the text as its arguments. Other command carriers are dropped. Text
 * without a carrier is returned unchanged.
 */
export function restoreHarnessCommandMentions(text: string): string {
  const references = harnessCommandReferences(text);
  const first = references[0];
  if (!first) return text;
  let rest = "";
  let cursor = 0;
  for (const reference of references) {
    let beforeStart = reference.start;
    while (
      beforeStart > cursor &&
      (text[beforeStart - 1] === " " || text[beforeStart - 1] === "\t")
    ) {
      beforeStart--;
    }
    let afterEnd = reference.end;
    while (afterEnd < text.length && (text[afterEnd] === " " || text[afterEnd] === "\t")) {
      afterEnd++;
    }
    rest += text.slice(cursor, beforeStart);
    // Normalize only the separator left by this chip, not argument whitespace.
    if (beforeStart < reference.start || afterEnd > reference.end) rest += " ";
    cursor = afterEnd;
  }
  rest += text.slice(cursor);
  const argumentsText = rest.trim();
  return argumentsText ? `${first.invocation} ${argumentsText}` : first.invocation;
}
