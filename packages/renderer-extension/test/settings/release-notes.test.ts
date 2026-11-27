import { describe, expect, it } from "vitest";

import { createReleaseNotesElement } from "../../src/settings/release-notes.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  className = "";
  textContent = "";

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  append(...nodes: unknown[]): void {
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}

function visibleText(root: FakeElement): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (node) parts.push(node);
      return;
    }
    if (!(node instanceof FakeElement)) return;
    if (node.children.length === 0) {
      if (node.textContent) parts.push(node.textContent);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return parts.join(" ");
}

function render(markdown: string): FakeElement {
  return createReleaseNotesElement(
    new FakeDocument() as unknown as Document,
    markdown,
  ) as unknown as FakeElement;
}

describe("Release notes Markdown", () => {
  it("renders inline code, emphasis, links, and ordered lists", () => {
    const root = render(
      [
        "Use `codexhost` and **restart** after install.",
        "",
        "1. Download the package",
        "2. Open [Releases](https://github.com/BytePioneer-AI/codex-host/releases)",
      ].join("\n"),
    );

    expect(root.children.map((child) => (child as FakeElement).tagName)).toEqual(["p", "ol"]);
    const code = descendants(root).find((element) => element.tagName === "code");
    expect(code?.textContent).toBe("codexhost");
    const strong = descendants(root).find((element) => element.tagName === "strong");
    expect(strong?.textContent).toBe("restart");
    const link = descendants(root).find((element) => element.tagName === "a");
    expect(link?.textContent).toBe("Releases");
    expect(link?.attributes.get("href")).toBe(
      "https://github.com/BytePioneer-AI/codex-host/releases",
    );
    expect(link?.attributes.get("target")).toBe("_blank");
    expect(link?.attributes.get("rel")).toBe("noopener noreferrer");
  });

  it("renders release-note blockquotes and does not create unsafe links", () => {
    const root = render(
      [
        "> **Note / 提示**: Linux x64/ARM64 users install via npm.",
        ">",
        "> See [the release](javascript:alert(1)).",
        "---",
      ].join("\n"),
    );

    expect(root.children.map((child) => (child as FakeElement).tagName)).toEqual([
      "blockquote",
      "hr",
    ]);
    const blockquote = descendants(root).find((element) => element.tagName === "blockquote");
    expect(visibleText(blockquote as FakeElement)).toContain("Note / 提示");
    expect(descendants(root).some((element) => element.tagName === "a")).toBe(false);
    expect(visibleText(root)).toContain("the release");
    expect(visibleText(root)).not.toContain("> ");
  });

  it("renders collapsible details blocks with summary and inner Markdown", () => {
    const root = render(
      [
        "## 📋 完整更新清单",
        "<details>",
        "<summary>展开查看全部新功能与修复</summary>",
        "",
        "### 🚀 新功能",
        "- Composer：新增 `codexhost` 快捷键",
        "",
        "### 🐛 修复",
        "- Windows：修复重启异常",
        "</details>",
      ].join("\n"),
    );

    expect(root.children.map((child) => (child as FakeElement).tagName)).toEqual(["h2", "details"]);
    const details = root.children[1] as FakeElement;
    expect(details.attributes.has("open")).toBe(false);
    const summary = details.children[0] as FakeElement;
    expect(summary.tagName).toBe("summary");
    expect(visibleText(summary)).toBe("展开查看全部新功能与修复");
    const body = details.children[1] as FakeElement;
    expect(body.className).toBe("settings-update-notes-details-body");
    expect(body.children.map((child) => (child as FakeElement).tagName)).toEqual([
      "h3",
      "ul",
      "h3",
      "ul",
    ]);
    expect(visibleText(body)).toContain("codexhost");
    expect(visibleText(body)).not.toContain("<details>");
  });

  it("keeps literal details tags inside fenced code", () => {
    const codeLines = ["</details>", "<details open>", "  <p>Literal HTML</p>"];
    const root = render(
      [
        "<details>",
        "<summary>HTML example</summary>",
        "",
        "```html",
        ...codeLines,
        "```",
        "",
        "<details open>",
        "<summary>Nested notes</summary>",
        "Nested content.",
        "</details>",
        "Still inside the outer details.",
        "</details>",
        "Outside the details.",
      ].join("\n"),
    );

    expect(root.children.map((child) => (child as FakeElement).tagName)).toEqual(["details", "p"]);
    const [details, outside] = root.children as [FakeElement, FakeElement];
    const body = details.children[1] as FakeElement;
    expect(body.children.map((child) => (child as FakeElement).tagName)).toEqual([
      "pre",
      "details",
      "p",
    ]);
    const [pre, nested, inside] = body.children as [FakeElement, FakeElement, FakeElement];
    const code = pre.children[0] as FakeElement;
    expect(code.tagName).toBe("code");
    expect(code.className).toBe("language-html");
    expect(code.textContent).toBe(codeLines.join("\n"));
    expect(nested.attributes.has("open")).toBe(true);
    expect(visibleText(nested)).toBe("Nested notes Nested content.");
    expect(visibleText(inside)).toBe("Still inside the outer details.");
    expect(visibleText(outside)).toBe("Outside the details.");
  });
});
