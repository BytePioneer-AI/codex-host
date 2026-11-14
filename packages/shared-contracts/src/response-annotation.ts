/**
 * Response annotations: text the user selected inside an earlier assistant
 * response and attached to their next message.
 *
 * The annotated text travels to the Harness as one prefix block of the user
 * message itself, not as a separate input item or metadata: the same string is
 * written to the session log, so every surface derives its display from it.
 * `formatResponseAnnotations` and the `## My request:` separator reproduce the
 * Codex Desktop prompt text exactly, punctuation and trailing newline
 * included; a change here changes what the model reads in every Thread.
 */

/** One selected passage, in the shape the Desktop prompt block carries. */
export interface ResponseAnnotation {
  /** Selected text, already trimmed. */
  readonly text: string;
  /** Optional user comment about the selection. */
  readonly annotation?: string;
}

/** Block heading; the payload below it is JSON in array order. */
export const RESPONSE_ANNOTATIONS_HEADER = "# Response annotations:";

/** Wrapper elements around the JSON payload. */
export const RESPONSE_ANNOTATIONS_OPEN = "<response-annotations>";
export const RESPONSE_ANNOTATIONS_CLOSE = "</response-annotations>";

/** Separator the request body follows; the block above it is context. */
export const RESPONSE_ANNOTATIONS_REQUEST_HEADER = "## My request:";

/** The separator a request body follows, in every form Desktop has written. */
const REQUEST_SEPARATOR = /## My request(?: for Codex)?:/gu;

/**
 * Instructions that make the annotations addressable in the reply. The reply
 * cites each answered selection as `:codex-annotation{index="N"}`.
 */
export const RESPONSE_ANNOTATIONS_GUIDANCE =
  "Each item contains text selected from an earlier Codex response and may include a user comment. " +
  "Treat items as Annotation 1, Annotation 2, and so on in array order. " +
  "Use every selection as context and address every comment. " +
  'For every annotation you address, include its inline directive `:codex-annotation{index="N"}`' +
  ', where N is its one-based array position (for example, `:codex-annotation{index="1"}`). ' +
  "Do not use unstructured annotation labels.";

/**
 * Build the annotation block that precedes the request body.
 * @param annotations - selections in attachment order.
 * @returns the block with a leading and trailing newline, or "" when empty.
 */
export function formatResponseAnnotations(annotations: readonly ResponseAnnotation[]): string {
  if (annotations.length === 0) return "";
  const payload = annotations.map(({ text, annotation }) => ({
    text,
    ...(annotation === undefined ? {} : { annotation }),
  }));
  return (
    `\n${RESPONSE_ANNOTATIONS_HEADER}\n` +
    `${RESPONSE_ANNOTATIONS_GUIDANCE}\n` +
    `${RESPONSE_ANNOTATIONS_OPEN}\n` +
    `${JSON.stringify(payload)}\n` +
    `${RESPONSE_ANNOTATIONS_CLOSE}\n`
  );
}

/**
 * Compose one user message from annotations and the request body.
 * @param annotations - selections in attachment order.
 * @param body - what the user typed.
 * @returns the complete message text.
 */
export function composeAnnotatedMessage(
  annotations: readonly ResponseAnnotation[],
  body: string,
): string {
  const block = formatResponseAnnotations(annotations);
  if (block === "") return body;
  return `${block}\n${RESPONSE_ANNOTATIONS_REQUEST_HEADER}\n${body}\n`;
}

/** Parsed user message: the annotation block plus the request body. */
export interface ParsedAnnotatedMessage {
  readonly annotations: readonly ResponseAnnotation[];
  readonly body: string;
}

function readSection(text: string): string {
  // The block is always the message prefix (a body that happens to quote the
  // heading is not a block), so the heading must open the message.
  const start = text.trimStart().startsWith(RESPONSE_ANNOTATIONS_HEADER) ? 0 : text.length;
  const open = text.indexOf(`\n${RESPONSE_ANNOTATIONS_OPEN}\n`, start);
  if (open < 0) return "";
  const from = open + 1 + RESPONSE_ANNOTATIONS_OPEN.length + 1;
  const close = text.indexOf(`\n${RESPONSE_ANNOTATIONS_CLOSE}`, from);
  return close < 0 ? "" : text.slice(from, close);
}

/**
 * Split a logged user message into its annotations and the visible body.
 * @param text - the message text as sent.
 * @returns annotations (empty without a block) and the body after the request header.
 */
export function parseAnnotatedMessage(text: string): ParsedAnnotatedMessage {
  const annotations = readAnnotations(text);
  return { annotations, body: requestBody(text) };
}

/** The body after the last request separator, as Desktop reads it. */
function requestBody(text: string): string {
  let start = 0;
  for (const match of text.matchAll(REQUEST_SEPARATOR)) start = match.index + match[0].length;
  return text.slice(start).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The annotations of one block, validated as a whole: an entry that is not
 * this shape invalidates the block rather than renumbering the rest.
 */
function readAnnotations(text: string): readonly ResponseAnnotation[] {
  const json = readSection(text);
  if (json === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // A hand-edited or foreign block is not this contract; the text stays visible.
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
  const annotations: ResponseAnnotation[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return [];
    const { text: value, annotation } = entry;
    if (typeof value !== "string" || value.length === 0) return [];
    if (annotation !== undefined && (typeof annotation !== "string" || annotation.length === 0))
      return [];
    annotations.push({
      text: value,
      ...(annotation === undefined ? {} : { annotation }),
    });
  }
  return annotations;
}

/**
 * Read the annotations of one logged user message without splitting its body.
 * @param text - the message text as sent.
 * @returns the annotations in attachment order; empty when the message carries none.
 */
export function responseAnnotationsOf(text: string): readonly ResponseAnnotation[] {
  return readAnnotations(text);
}

/**
 * Read the position an inline annotation reference names.
 *
 * The reference is the Markdown directive `:codex-annotation{index="N"}`.
 * Desktop accepts only a canonical positive integer literal; anything else
 * (`01`, `0`, `-1`, a word) leaves the reference without a position, and the
 * reply's renderer then draws nothing for it.
 * @param raw - the `index` attribute as the reply wrote it.
 * @returns the one-based attachment position, or undefined for any other value.
 */
export function responseAnnotationIndex(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const index = Number(raw);
  return Number.isSafeInteger(index) && index > 0 && String(index) === raw ? index : undefined;
}
