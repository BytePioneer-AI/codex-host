/** Safe-subset Markdown renderer for extension details (no raw HTML injection). */
import { Fragment, type ReactNode } from "react";
import { parseSafeHttpUrl } from "./web-extensions-helpers.ts";

const FENCE_PATTERN = /^\s*```/u;
const HEADING_PATTERN = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/u;
const UNORDERED_LIST_PATTERN = /^\s*[-*]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^\s*\d+\.\s+(.+)$/u;
const BLOCKQUOTE_PATTERN = /^\s*>\s?(.*)$/u;

export interface MarkdownClassNames {
  readonly root: string;
  readonly paragraph: string;
  readonly h3: string;
  readonly h4: string;
  readonly h5: string;
  readonly list: string;
  readonly orderedList: string;
  readonly code: string;
  readonly pre: string;
  readonly quote: string;
  readonly link: string;
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
): { readonly label: string; readonly rawUrl: string; readonly endIndex: number } | null {
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

function renderInline(
  text: string,
  classes: MarkdownClassNames,
  keyPrefix: string,
  allowLinks = true,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let plainStart = 0;
  let part = 0;

  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      nodes.push(text.slice(plainStart, end));
    }
  };

  while (cursor < text.length) {
    const ch = text[cursor];

    if (ch === "`") {
      const closeTick = text.indexOf("`", cursor + 1);
      if (closeTick > cursor + 1) {
        flushPlain(cursor);
        nodes.push(
          <code key={`${keyPrefix}-c-${String(part++)}`} className={classes.code}>
            {text.slice(cursor + 1, closeTick)}
          </code>,
        );
        cursor = closeTick + 1;
        plainStart = cursor;
        continue;
      }
    }

    if (allowLinks && ch === "[") {
      const match = findLinkEnd(text, cursor);
      if (match) {
        flushPlain(cursor);
        const safeUrl = parseSafeHttpUrl(match.rawUrl);
        if (safeUrl) {
          const linkKey = `${keyPrefix}-a-${String(part++)}`;
          nodes.push(
            <a
              key={linkKey}
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={classes.link}
            >
              {renderInline(match.label, classes, linkKey, false)}
            </a>,
          );
        } else {
          nodes.push(match.label);
        }
        cursor = match.endIndex;
        plainStart = cursor;
        continue;
      }
    }

    if (ch === "*" && text[cursor + 1] === "*") {
      const closeBold = text.indexOf("**", cursor + 2);
      if (closeBold > cursor + 2) {
        flushPlain(cursor);
        const boldKey = `${keyPrefix}-b-${String(part++)}`;
        nodes.push(
          <strong key={boldKey}>
            {renderInline(text.slice(cursor + 2, closeBold), classes, boldKey, allowLinks)}
          </strong>,
        );
        cursor = closeBold + 2;
        plainStart = cursor;
        continue;
      }
    }

    if (ch === "*" && text[cursor + 1] !== "*") {
      const closeItalic = findSingleItalicEnd(text, cursor);
      if (closeItalic > cursor + 1) {
        flushPlain(cursor);
        const emKey = `${keyPrefix}-i-${String(part++)}`;
        nodes.push(
          <em key={emKey}>
            {renderInline(text.slice(cursor + 1, closeItalic), classes, emKey, allowLinks)}
          </em>,
        );
        cursor = closeItalic + 1;
        plainStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  flushPlain(text.length);
  return nodes;
}

function renderParagraph(
  lines: readonly string[],
  classes: MarkdownClassNames,
  key: string,
): ReactNode {
  return (
    <p key={key} className={classes.paragraph}>
      {lines.map((line, lineIndex) => (
        <Fragment key={`${key}-l-${String(lineIndex)}`}>
          {lineIndex > 0 && <br />}
          {renderInline(line, classes, `${key}-l-${String(lineIndex)}`)}
        </Fragment>
      ))}
    </p>
  );
}

export function WebExtensionMarkdown({
  content,
  classes,
}: {
  content: string | null;
  classes: MarkdownClassNames;
}): ReactNode {
  if (!content) return null;
  const normalized = content.replace(/\r\n?/gu, "\n");
  if (!normalized.trim()) return null;

  const lines = normalized.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;

    if (!line.trim()) {
      index += 1;
      continue;
    }

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
      if (closingFence !== undefined && FENCE_PATTERN.test(closingFence)) index += 1;
      blocks.push(
        <pre key={`b-${String(blockIndex++)}`} className={classes.pre}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch?.[1] && headingMatch[2] !== undefined) {
      const level = headingMatch[1].length;
      const key = `b-${String(blockIndex++)}`;
      const children = renderInline(headingMatch[2].trim(), classes, key);
      if (level === 1)
        blocks.push(
          <h3 key={key} className={classes.h3}>
            {children}
          </h3>,
        );
      else if (level === 2)
        blocks.push(
          <h4 key={key} className={classes.h4}>
            {children}
          </h4>,
        );
      else
        blocks.push(
          <h5 key={key} className={classes.h5}>
            {children}
          </h5>,
        );
      index += 1;
      continue;
    }

    if (BLOCKQUOTE_PATTERN.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index];
        const quoteMatch = currentLine?.match(BLOCKQUOTE_PATTERN);
        if (!quoteMatch || quoteMatch[1] === undefined) break;
        quoteLines.push(quoteMatch[1]);
        index += 1;
      }
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
      if (quoteParagraphs.length > 0) {
        const quoteKey = `b-${String(blockIndex++)}`;
        blocks.push(
          <blockquote key={quoteKey} className={classes.quote}>
            {quoteParagraphs.map((paragraphLines, pIndex) =>
              renderParagraph(paragraphLines, classes, `${quoteKey}-q-${String(pIndex)}`),
            )}
          </blockquote>,
        );
      }
      continue;
    }

    if (UNORDERED_LIST_PATTERN.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index];
        const itemMatch = currentLine?.match(UNORDERED_LIST_PATTERN);
        if (!itemMatch || itemMatch[1] === undefined) break;
        items.push(itemMatch[1].trim());
        index += 1;
      }
      const listKey = `b-${String(blockIndex++)}`;
      blocks.push(
        <ul key={listKey} className={classes.list}>
          {items.map((itemText, itemIndex) => (
            <li key={`${listKey}-li-${String(itemIndex)}`}>
              {renderInline(itemText, classes, `${listKey}-li-${String(itemIndex)}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (ORDERED_LIST_PATTERN.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const currentLine = lines[index];
        const itemMatch = currentLine?.match(ORDERED_LIST_PATTERN);
        if (!itemMatch || itemMatch[1] === undefined) break;
        items.push(itemMatch[1].trim());
        index += 1;
      }
      const listKey = `b-${String(blockIndex++)}`;
      blocks.push(
        <ol key={listKey} className={`${classes.list} ${classes.orderedList}`}>
          {items.map((itemText, itemIndex) => (
            <li key={`${listKey}-li-${String(itemIndex)}`}>
              {renderInline(itemText, classes, `${listKey}-li-${String(itemIndex)}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const nextLine = lines[index];
      if (nextLine === undefined || !nextLine.trim() || isBlockStart(nextLine)) break;
      paragraphLines.push(nextLine);
      index += 1;
    }
    blocks.push(renderParagraph(paragraphLines, classes, `b-${String(blockIndex++)}`));
  }

  if (blocks.length === 0) return null;
  return <div className={classes.root}>{blocks}</div>;
}
