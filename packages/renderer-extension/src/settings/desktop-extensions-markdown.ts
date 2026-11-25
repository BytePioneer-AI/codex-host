import { createEl, parseSafeHttpUrl } from "./desktop-extensions-shared.js";

const FENCE_PATTERN = /^\s*```/u;
const HEADING_PATTERN = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/u;
const UNORDERED_LIST_PATTERN = /^\s*[-*]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^\s*\d+\.\s+(.+)$/u;
const BLOCKQUOTE_PATTERN = /^\s*>\s?(.*)$/u;

function appendText(document: Document, parent: HTMLElement, text: string): void {
  if (!text) return;
  parent.append(document.createTextNode(text));
}

function isBlockStart(line: string): boolean {
  return (
    FENCE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    UNORDERED_LIST_PATTERN.test(line) ||
    ORDERED_LIST_PATTERN.test(line) ||
    BLOCKQUOTE_PATTERN.test(line)
  );
}

function findLinkEnd(
  text: string,
  startIndex: number,
): {
  readonly label: string;
  readonly rawUrl: string;
  readonly endIndex: number;
} | null {
  // Expect text[startIndex] === "["
  const closeBracket = text.indexOf("]", startIndex + 1);
  if (closeBracket <= startIndex + 1) return null;
  if (text[closeBracket + 1] !== "(") return null;

  const urlStart = closeBracket + 2;
  let depth = 1;
  let cursor = urlStart;
  while (cursor < text.length && depth > 0) {
    const ch = text[cursor];
    if (ch === "\n" || ch === "\r") return null;
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0) return null;

  const label = text.slice(startIndex + 1, closeBracket);
  const rawUrl = text.slice(urlStart, cursor - 1).trim();
  if (!label || !rawUrl) return null;
  return { label, rawUrl, endIndex: cursor };
}

function findSingleItalicEnd(text: string, startIndex: number): number {
  let cursor = startIndex + 1;
  while (cursor < text.length) {
    if (text[cursor] === "*") {
      if (text[cursor + 1] === "*") {
        cursor += 2;
        continue;
      }
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

function appendInlineNodes(
  document: Document,
  parent: HTMLElement,
  text: string,
  allowLinks = true,
): void {
  let cursor = 0;
  let plainStart = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      appendText(document, parent, text.slice(plainStart, end));
    }
  };

  while (cursor < text.length) {
    const ch = text[cursor];

    // Inline code: `code`
    if (ch === "`") {
      const closeTick = text.indexOf("`", cursor + 1);
      if (closeTick > cursor + 1) {
        flushPlain(cursor);
        const codeEl = createEl(document, "code", "settings-extensions-md__code");
        appendText(document, codeEl, text.slice(cursor + 1, closeTick));
        parent.append(codeEl);
        cursor = closeTick + 1;
        plainStart = cursor;
        continue;
      }
    }

    // Link: [label](url) — only http:// and https:// produce an <a>
    if (allowLinks && ch === "[") {
      const match = findLinkEnd(text, cursor);
      if (match) {
        flushPlain(cursor);
        const safeUrl = parseSafeHttpUrl(match.rawUrl);
        if (safeUrl) {
          const anchor = createEl(document, "a", "settings-extensions-md__link");
          anchor.href = safeUrl;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          appendInlineNodes(document, anchor, match.label, false);
          parent.append(anchor);
        } else {
          appendText(document, parent, match.label);
        }
        cursor = match.endIndex;
        plainStart = cursor;
        continue;
      }
    }

    // Bold: **text**
    if (ch === "*" && text[cursor + 1] === "*") {
      const closeBold = text.indexOf("**", cursor + 2);
      if (closeBold > cursor + 2) {
        flushPlain(cursor);
        const strong = createEl(document, "strong");
        appendInlineNodes(document, strong, text.slice(cursor + 2, closeBold), allowLinks);
        parent.append(strong);
        cursor = closeBold + 2;
        plainStart = cursor;
        continue;
      }
    }

    // Italic: *text*
    if (ch === "*" && text[cursor + 1] !== "*") {
      const closeItalic = findSingleItalicEnd(text, cursor);
      if (closeItalic > cursor + 1) {
        flushPlain(cursor);
        const em = createEl(document, "em");
        appendInlineNodes(document, em, text.slice(cursor + 1, closeItalic), allowLinks);
        parent.append(em);
        cursor = closeItalic + 1;
        plainStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushPlain(text.length);
}

function createParagraph(document: Document, lines: readonly string[]): HTMLParagraphElement {
  const paragraph = createEl(document, "p", "settings-extensions-detail-modal__paragraph");
  for (const [i, line] of lines.entries()) {
    if (i > 0) paragraph.append(document.createElement("br"));
    appendInlineNodes(document, paragraph, line);
  }
  return paragraph;
}

/**
 * Renders a safe subset of Markdown into DOM elements using only `createElement`
 * and `createTextNode` (never `innerHTML`).
 */
export function renderSafeMarkdown(document: Document, raw: string | null): HTMLElement[] {
  if (!raw) return [];
  const normalized = raw.replace(/\r\n?/gu, "\n");
  if (!normalized.trim()) return [];

  const lines = normalized.split("\n");
  const blocks: HTMLElement[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block: ``` ... ```
    if (FENCE_PATTERN.test(line)) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length) {
        const codeLine = lines[index];
        if (codeLine === undefined || FENCE_PATTERN.test(codeLine)) break;
        codeLines.push(codeLine);
        index += 1;
      }
      const closingFence = lines[index];
      if (closingFence !== undefined && FENCE_PATTERN.test(closingFence)) {
        index += 1;
      }
      const pre = createEl(document, "pre", "settings-extensions-md__pre");
      const code = createEl(document, "code");
      appendText(document, code, codeLines.join("\n"));
      pre.append(code);
      blocks.push(pre);
      continue;
    }

    // Headings: #, ##, ### -> h3, h4, h5
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      const heading = createEl(document, tag, `settings-extensions-md__${tag}`);
      appendInlineNodes(document, heading, headingMatch[2].trim());
      blocks.push(heading);
      index += 1;
      continue;
    }

    // Blockquote: consecutive > lines
    if (BLOCKQUOTE_PATTERN.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index];
        const quoteMatch = currentLine?.match(BLOCKQUOTE_PATTERN);
        if (!quoteMatch || quoteMatch[1] === undefined) break;
        quoteLines.push(quoteMatch[1]);
        index += 1;
      }
      const blockquote = createEl(document, "blockquote", "settings-extensions-md__quote");
      const quoteParagraphs: string[][] = [];
      let current: string[] = [];
      for (const quoteLine of quoteLines) {
        if (!quoteLine.trim()) {
          if (current.length > 0) {
            quoteParagraphs.push(current);
            current = [];
          }
        } else {
          current.push(quoteLine);
        }
      }
      if (current.length > 0) quoteParagraphs.push(current);
      for (const paragraphLines of quoteParagraphs) {
        blockquote.append(createParagraph(document, paragraphLines));
      }
      if (quoteParagraphs.length > 0) {
        blocks.push(blockquote);
      }
      continue;
    }

    // Unordered list: consecutive - / * lines
    if (UNORDERED_LIST_PATTERN.test(line)) {
      const ul = createEl(document, "ul", "settings-extensions-md__list");
      while (index < lines.length) {
        const currentLine = lines[index];
        const itemMatch = currentLine?.match(UNORDERED_LIST_PATTERN);
        if (!itemMatch || itemMatch[1] === undefined) break;
        const li = createEl(document, "li");
        appendInlineNodes(document, li, itemMatch[1].trim());
        ul.append(li);
        index += 1;
      }
      blocks.push(ul);
      continue;
    }

    // Ordered list: consecutive 1. lines
    if (ORDERED_LIST_PATTERN.test(line)) {
      const ol = createEl(
        document,
        "ol",
        "settings-extensions-md__list settings-extensions-md__list--ordered",
      );
      while (index < lines.length) {
        const currentLine = lines[index];
        const itemMatch = currentLine?.match(ORDERED_LIST_PATTERN);
        if (!itemMatch || itemMatch[1] === undefined) break;
        const li = createEl(document, "li");
        appendInlineNodes(document, li, itemMatch[1].trim());
        ol.append(li);
        index += 1;
      }
      blocks.push(ol);
      continue;
    }

    // Paragraph: consecutive non-empty lines until blank line or next block start
    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index];
      if (nextLine === undefined || !nextLine.trim() || isBlockStart(nextLine)) break;
      paragraphLines.push(nextLine);
      index += 1;
    }
    blocks.push(createParagraph(document, paragraphLines));
  }

  return blocks;
}
