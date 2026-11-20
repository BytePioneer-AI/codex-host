import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "../../src/settings/desktop-extensions-markdown.js";

class FakeTextNode {
  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly children: Array<FakeElement | FakeTextNode | string> = [];
  className = "";
  href = "";
  target = "";
  rel = "";

  constructor(readonly tagName: string) {}

  get innerHTML(): never {
    throw new Error("innerHTML must never be accessed");
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML must never be written");
  }

  append(...nodes: Array<FakeElement | FakeTextNode | string>): void {
    this.children.push(...nodes);
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase());
  }

  createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text);
  }
}

function collectElements(nodes: readonly FakeElement[]): FakeElement[] {
  const result: FakeElement[] = [];
  const visit = (node: FakeElement | FakeTextNode | string): void => {
    if (!(node instanceof FakeElement)) return;
    result.push(node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
}

function textOf(node: FakeElement | FakeTextNode | string): string {
  if (typeof node === "string") return node;
  if (node instanceof FakeTextNode) return node.textContent;
  return node.children.map(textOf).join("");
}

function render(markdown: string | null): FakeElement[] {
  const doc = new FakeDocument();
  return renderSafeMarkdown(doc as unknown as Document, markdown) as unknown as FakeElement[];
}

function must<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${label} to be defined`);
  return value;
}

describe("renderSafeMarkdown", () => {
  it("returns empty array for empty or whitespace-only input", () => {
    expect(render(null)).toEqual([]);
    expect(render("   \n\n\t ")).toEqual([]);
  });

  it("renders headings (h3-h5), unordered/ordered lists, blockquotes, fenced code blocks, and line breaks", () => {
    const markdown = [
      "# Overview",
      "## Key *Features*",
      "### Notes with `code`",
      "",
      "Line one with **bold** and *italic* and `inline **raw**`.",
      "Line two in same paragraph.",
      "",
      "- First item with **emphasis**",
      "* Second item with [Docs](https://example.com/docs)",
      "",
      "1. Step one",
      "2. Step two with `npm test`",
      "",
      "> Quoted **warning** line 1",
      "> line 2",
      "",
      "```ts",
      "const x = '<script>alert(1)</script>';",
      "console.log(x);",
      "```",
    ].join("\n");

    const blocks = render(markdown);
    expect(blocks.map((block) => block.tagName)).toEqual([
      "h3",
      "h4",
      "h5",
      "p",
      "ul",
      "ol",
      "blockquote",
      "pre",
    ]);

    // Headings map # / ## / ### -> h3 / h4 / h5 with inline formatting.
    expect(textOf(must(blocks[0]))).toBe("Overview");
    expect(collectElements([must(blocks[1])]).some((el) => el.tagName === "em")).toBe(true);
    expect(collectElements([must(blocks[2])]).some((el) => el.tagName === "code")).toBe(true);

    // Paragraph preserves single line break via <br>, renders <strong>, <em>, and keeps code literal.
    const paragraphChildren = collectElements([must(blocks[3])]);
    expect(paragraphChildren.map((el) => el.tagName)).toEqual(["p", "strong", "em", "code", "br"]);
    const inlineCode = must(paragraphChildren.find((el) => el.tagName === "code"));
    expect(textOf(inlineCode)).toBe("inline **raw**");

    // Unordered list + safe https link.
    const ulBlock = must(blocks[4]);
    const ulItems = ulBlock.children.filter((c): c is FakeElement => c instanceof FakeElement);
    expect(ulItems.map((li) => li.tagName)).toEqual(["li", "li"]);
    const link = must(collectElements([ulBlock]).find((el) => el.tagName === "a"));
    expect(link).toBeDefined();
    expect(link.href).toBe("https://example.com/docs");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(textOf(link)).toBe("Docs");

    // Ordered list.
    const olItems = must(blocks[5]).children.filter(
      (c): c is FakeElement => c instanceof FakeElement,
    );
    expect(olItems.map((li) => textOf(li))).toEqual(["Step one", "Step two with npm test"]);

    // Blockquote preserves multiline content and inline strong.
    const quoteElements = collectElements([must(blocks[6])]);
    expect(quoteElements.some((el) => el.tagName === "strong")).toBe(true);
    expect(quoteElements.some((el) => el.tagName === "br")).toBe(true);

    // Fenced code block preserves raw HTML characters as literal text inside <pre><code>.
    const preCode = must(blocks[7]).children[0] as FakeElement;
    expect(preCode.tagName).toBe("code");
    expect(textOf(preCode)).toBe("const x = '<script>alert(1)</script>';\nconsole.log(x);");
  });

  it("downgrades unsafe link protocols and raw HTML injections to plain text without creating executable elements", () => {
    const hostile = [
      "Click [bad js](javascript:alert(1)) or [bad data](data:text/html,<script>alert(1)</script>).",
      "",
      "<script>alert('xss')</script><img src=x onerror=alert(1)>",
      "",
      "Safe link: [GitHub](https://github.com/BytePioneer-AI/codex-host)",
    ].join("\n");

    const blocks = render(hostile);
    const all = collectElements(blocks);

    // Zero <script> or <img> elements created.
    expect(all.filter((el) => el.tagName === "script" || el.tagName === "img")).toHaveLength(0);

    // Only the safe https:// link becomes an <a>.
    const anchors = all.filter((el) => el.tagName === "a");
    expect(anchors).toHaveLength(1);
    const safeAnchor = must(anchors[0]);
    expect(safeAnchor.href).toBe("https://github.com/BytePioneer-AI/codex-host");
    expect(safeAnchor.target).toBe("_blank");
    expect(safeAnchor.rel).toBe("noopener noreferrer");

    // Unsafe links downgrade to plain text labels and raw HTML stays escaped text nodes.
    expect(textOf(must(blocks[0]))).toBe("Click bad js or bad data.");
    expect(textOf(must(blocks[1]))).toBe(
      "<script>alert('xss')</script><img src=x onerror=alert(1)>",
    );
  });
});
