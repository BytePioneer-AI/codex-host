import type { ResponseAnnotationAnchor } from "@deepseek-ai/dsh-client-ui-conversation/src/client/contract/response-annotation-anchor.ts";

/** Chrome that never contributes selected prose or counted response text. */
export const EXCLUDED_SELECTION = [
  "[data-code-block-controls]",
  "[data-selection-actions]",
  "[contenteditable='true']",
  "textarea",
].join(",");

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SHOW_TEXT = 4;

/** Blocks whose edges are line breaks of their own, as Desktop's serializer reads them. */
const BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
]);

/** Project the selection using the same block and line boundaries as Desktop. */
export function selectedText(range: Range): string {
  const ownerDocument = range.startContainer.ownerDocument;
  if (ownerDocument === null) return "";
  const container = ownerDocument.createElement("div");
  container.append(range.cloneContents());
  for (const excluded of container.querySelectorAll(EXCLUDED_SELECTION)) excluded.remove();
  // A list stands where its text stands: Desktop replaces it with a newline
  // followed by the list's own children before projecting text.
  for (const list of container.querySelectorAll("ol, ul"))
    list.replaceWith("\n", ...Array.from(list.childNodes));
  const common = range.commonAncestorContainer;
  const rootParentTag =
    common.nodeType === ELEMENT_NODE
      ? (common as Element).tagName
      : (common.parentElement?.tagName ?? container.tagName);
  return serialize(container, rootParentTag).trim();
}

/**
 * Capture a response selection as a stable answer-local UTF-16 interval.
 *
 * Excluded controls contribute no text to the interval, so a toolbar changing
 * its DOM cannot move the range into a repeated prose passage.
 */
export function captureResponseAnnotationAnchor(
  host: Element,
  range: Range,
): ResponseAnnotationAnchor | undefined {
  const answerKey = host.getAttribute("data-selection-answer");
  if (
    !answerKey ||
    range.collapsed ||
    !host.contains(range.startContainer) ||
    !host.contains(range.endContainer)
  )
    return undefined;

  let start = 0;
  let end = 0;
  for (const node of responseTextNodes(host)) {
    const relative = range.comparePoint(node, node.length);
    if (node === range.startContainer) start += range.startOffset;
    else if (relative < 0) start += node.length;
    if (node === range.endContainer) {
      end += range.endOffset;
      break;
    }
    if (relative > 0) break;
    end += node.length;
  }
  return end > start && selectedText(range) !== "" ? { answerKey, start, end } : undefined;
}

/**
 * Restore an answer-local interval after the reply's DOM has been rendered
 * again, accepting it only when the projected text still matches exactly.
 */
export function restoreResponseAnnotationRange(
  host: Element,
  anchor: ResponseAnnotationAnchor,
  text: string,
): Range | undefined {
  if (
    host.getAttribute("data-selection-answer") !== anchor.answerKey ||
    !Number.isSafeInteger(anchor.start) ||
    !Number.isSafeInteger(anchor.end) ||
    anchor.start < 0 ||
    anchor.end <= anchor.start
  )
    return undefined;

  let position = 0;
  let range: Range | undefined;
  for (const node of responseTextNodes(host)) {
    const next = position + node.length;
    if (range === undefined && anchor.start < next) {
      range = host.ownerDocument.createRange();
      range.setStart(node, anchor.start - position);
    }
    if (range !== undefined && anchor.end <= next) {
      range.setEnd(node, anchor.end - position);
      return selectedText(range) === text ? range : undefined;
    }
    position = next;
  }
  return undefined;
}

/** Find and validate an annotation's rendered owner in the current transcript. */
export function locateResponseAnnotation(
  root: Element,
  anchor: ResponseAnnotationAnchor,
  text: string,
): { readonly host: Element; readonly range: Range } | undefined {
  const hosts = root.matches("[data-selection-answer]")
    ? [root, ...root.querySelectorAll<Element>("[data-selection-answer]")]
    : Array.from(root.querySelectorAll<Element>("[data-selection-answer]"));
  for (const host of hosts) {
    if (host.getAttribute("data-selection-answer") !== anchor.answerKey) continue;
    const range = restoreResponseAnnotationRange(host, anchor, text);
    if (range !== undefined) return { host, range };
  }
  return undefined;
}

function* responseTextNodes(host: Element): Iterable<Text> {
  const walker = host.ownerDocument.createTreeWalker(host, SHOW_TEXT);
  for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) {
    const text = next as Text;
    if (text.length > 0 && text.parentElement?.closest(EXCLUDED_SELECTION) == null) yield text;
  }
}

function serialize(parent: Element, parentTag = parent.tagName): string {
  let text = "";
  for (const child of parent.childNodes) text += serializeNode(child, parentTag);
  return text;
}

function serializeNode(node: Node, parentTag: string): string {
  if (node.nodeType === TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== ELEMENT_NODE) return "";
  const element = node as Element;
  switch (element.tagName) {
    case "BR":
      return "\n";
    case "TABLE":
      return `${Array.from(element.querySelectorAll("tr")).map(serializeRow).join("\n")}\n`;
    case "TD":
    case "TH":
      // A range between cell text nodes clones the cells without their row.
      return `${element.previousElementSibling?.matches("td, th") ? "\t" : ""}${serialize(element).trimEnd()}`;
    case "TR":
      return `${serializeRow(element)}\n`;
    case "THEAD":
    case "TBODY":
    case "TFOOT":
      return serialize(element);
    case "P":
      return serializeParagraph(element, parentTag);
    default: {
      const text = serialize(element);
      return BLOCK_TAGS.has(element.tagName) ? `${text}\n` : text;
    }
  }
}

function serializeRow(row: Element): string {
  return Array.from(row.children)
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => serialize(cell).trim())
    .join("\t");
}

function serializeParagraph(node: Element, parentTag: string): string {
  const previous = node.previousElementSibling;
  const separated =
    previous?.tagName === "P" &&
    previous.textContent?.trim() !== "" &&
    node.textContent?.trim() !== "" &&
    parentTag !== "LI"
      ? "\n"
      : "";
  return `${separated}${serialize(node)}\n`;
}
