/**
 * Attachment context Codex Desktop serializes ahead of the user's request:
 *
 * ```text
 * # Files mentioned by the user:
 *
 * ## shot.png: /absolute/path/shot.png
 * Image attachment: true
 *
 * ## My request:
 * …
 * ```
 *
 * A Harness receives a turn's images only as these paths, so the Host reads them back from the
 * same text. Paths the user typed into the request are never attachments.
 */
/** The context opens the prompt, after blank lines only. */
const ATTACHED_FILES_HEADING = /^\s*# Files mentioned by the user:[ \t]*(?:\r?\n|$)/u;
/** The first line that is exactly the request heading ends the context. */
const REQUEST_HEADING = /(?:^|\n)## My request:[ \t]*(?:\r?\n|$)/u;
const IMAGE_ATTACHMENT_PATTERN =
  /(?:^|\n)## [^\r\n]+: ((?:\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]+)\r?\nImage attachment: true(?=\r?\n|$)/gu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/**
 * Absolute image paths in the attachment context Desktop serialized into a prompt. The context
 * opens the prompt and ends at the request heading when present, or at the end of an image-only
 * prompt. Paths in the request body are not attachments.
 */
export function desktopImageAttachmentPaths(text: string): string[] {
  const end = text.search(REQUEST_HEADING);
  const context = end < 0 ? text : text.slice(0, end);
  if (!ATTACHED_FILES_HEADING.test(context)) return [];
  return [...context.matchAll(IMAGE_ATTACHMENT_PATTERN)]
    .map((match) => match[1] ?? "")
    .filter((path) => path.length > 0 && !CONTROL_CHARACTER_PATTERN.test(path));
}
