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
  it("renders the current GitHub Release subset as structured elements", () => {
    const root = render(
      [
        "codexhost 是一个将 Pi 和 Claude Code 接入 Codex Desktop 的跨平台 Host。",
        "",
        "## 本次发布",
        "",
        "- 新增 Grok CLI adapter：支持在 Codex Desktop 中通过 Grok 执行任务。",
        "- 集成 DeepSeek Harness：通过本地 Host 接入 DeepSeek。",
        "",
        "## 安装方式",
        "",
        "### npm",
        "",
        "```bash",
        "npm install -g @codexhost/cli",
        "codexhost",
        "```",
      ].join("\n"),
    );

    expect(root.className).toBe("settings-update-notes");
    expect(root.children.map((child) => (child as FakeElement).tagName)).toEqual([
      "p",
      "h2",
      "ul",
      "h2",
      "h3",
      "pre",
    ]);
    expect(visibleText(root)).toContain("本次发布");
    expect(visibleText(root)).not.toContain("##");
    expect(visibleText(root)).not.toContain("- 新增");
    expect(visibleText(root)).toContain("npm install -g @codexhost/cli");

    const list = descendants(root).find((element) => element.tagName === "ul");
    expect(list?.children).toHaveLength(2);
    const code = descendants(root).find((element) => element.tagName === "code");
    expect(code?.className).toBe("language-bash");
    expect(code?.textContent).toBe("npm install -g @codexhost/cli\ncodexhost");
  });

  it("preserves authored line breaks within bilingual paragraphs", () => {
    const root = render(
      [
        "Download the installer matching your OS and CPU architecture:",
        "下载与你的操作系统和 CPU 架构对应的安装包：",
      ].join("\n"),
    );

    const paragraph = descendants(root).find((element) => element.tagName === "p");
    expect(paragraph?.children).toHaveLength(3);
    expect((paragraph?.children[1] as FakeElement).tagName).toBe("br");
  });

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
});
