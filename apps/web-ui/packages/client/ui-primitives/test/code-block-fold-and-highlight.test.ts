// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, FOLD_LINE_THRESHOLD, FOLD_PREVIEW_LINES } from "../src/markdown/CodeBlock.tsx";
import {
  HIGHLIGHT_HTML_CACHE_MAX_ENTRIES,
  HighlightHtmlCache,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  StreamingHighlightSession,
  getHighlightHtmlCacheStats,
  highlightLines,
  highlightToHtml,
  resetHighlightHtmlCache,
} from "../src/markdown/highlight.ts";
import {
  CodeBlockFoldMemoryProvider,
  MarkdownDelegateProvider,
} from "../src/markdown/MarkdownDelegate.tsx";
import { MarkdownText } from "../src/markdown/MarkdownText.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeLines(count: number, prefix = "const line"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1} = ${index + 1};`).join(
    "\n",
  );
}

describe("highlight budget guard and bounded HTML LRU", () => {
  beforeEach(() => {
    resetHighlightHtmlCache();
  });

  it("skips Shiki tokenization when exceeding MAX_HIGHLIGHT_CHARS or MAX_HIGHLIGHT_LINES", () => {
    const tooManyChars = `const s = "${"a".repeat(MAX_HIGHLIGHT_CHARS)}";`;
    expect(tooManyChars.length).toBeGreaterThan(MAX_HIGHLIGHT_CHARS);
    expect(highlightToHtml(tooManyChars, "ts")).toBeUndefined();
    expect(highlightLines(tooManyChars, "ts")).toBeUndefined();
    expect(new StreamingHighlightSession().updateFrame(tooManyChars, "ts")).toBeUndefined();
    expect(getHighlightHtmlCacheStats().entries).toBe(0);

    const tooManyLines = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, () => "x").join("\n");
    expect(highlightToHtml(tooManyLines, "ts")).toBeUndefined();
    expect(highlightLines(tooManyLines, "ts")).toBeUndefined();
    expect(new StreamingHighlightSession().updateFrame(tooManyLines, "ts")).toBeUndefined();
    expect(getHighlightHtmlCacheStats().entries).toBe(0);

    // Exact line limit (with or without a single trailing newline) still highlights.
    const exactLineLimit = Array.from({ length: MAX_HIGHLIGHT_LINES }, () => "x").join("\n");
    expect(highlightLines(exactLineLimit, "ts")).toHaveLength(MAX_HIGHLIGHT_LINES);
    expect(highlightLines(`${exactLineLimit}\n`, "ts")).toHaveLength(MAX_HIGHLIGHT_LINES);

    // A streaming session that grows past the line limit resets to plain-text fallback.
    const session = new StreamingHighlightSession();
    expect(session.updateFrame("const a = 1;\n", "ts")).toBeDefined();
    expect(session.updateFrame(tooManyLines, "ts")).toBeUndefined();
  });

  it("caches highlightToHtml results by resolved grammar and enforces entry capacity", () => {
    const first = highlightToHtml("const answer = 42;", "ts");
    expect(first).toContain("shiki");
    expect(getHighlightHtmlCacheStats().entries).toBe(1);

    // Equivalent alias resolves to the same grammar key and hits cache without growing entries.
    const second = highlightToHtml("const answer = 42;", "typescript");
    expect(second).toBe(first);
    expect(getHighlightHtmlCacheStats().entries).toBe(1);

    // Filling beyond HIGHLIGHT_HTML_CACHE_MAX_ENTRIES evicts oldest entries.
    for (let index = 0; index < HIGHLIGHT_HTML_CACHE_MAX_ENTRIES + 5; index += 1) {
      expect(highlightToHtml(`const n = ${index};`, "ts")).toContain("shiki");
    }
    expect(getHighlightHtmlCacheStats().entries).toBe(HIGHLIGHT_HTML_CACHE_MAX_ENTRIES);
  });

  it("enforces LRU ordering and byte budgets in HighlightHtmlCache", () => {
    const byCount = new HighlightHtmlCache(2, 1024);
    byCount.set("a", "<pre>a</pre>");
    byCount.set("b", "<pre>b</pre>");
    // Promote "a" to most-recently-used so "b" is evicted next.
    expect(byCount.get("a")).toBe("<pre>a</pre>");
    byCount.set("c", "<pre>c</pre>");
    expect(byCount.size).toBe(2);
    expect(byCount.get("a")).toBe("<pre>a</pre>");
    expect(byCount.get("b")).toBeUndefined();
    expect(byCount.get("c")).toBe("<pre>c</pre>");

    // Byte budget evicts oldest entries and ignores single entries larger than the budget.
    const byBytes = new HighlightHtmlCache(10, 64);
    byBytes.set("k1", "1234567890"); // (2 + 10) * 2 = 24 bytes
    byBytes.set("k2", "1234567890"); // +24 = 48 bytes
    byBytes.set("k3", "1234567890"); // +24 = 72 > 64 -> evicts k1 -> 48 bytes
    expect(byBytes.get("k1")).toBeUndefined();
    expect(byBytes.get("k2")).toBe("1234567890");
    expect(byBytes.get("k3")).toBe("1234567890");
    expect(byBytes.bytes).toBeLessThanOrEqual(64);

    byBytes.set("huge", "x".repeat(40)); // (4 + 40) * 2 = 88 > 64 -> skipped
    expect(byBytes.get("huge")).toBeUndefined();
    expect(byBytes.size).toBe(2);
  });
});

describe("CodeBlock folding, clipboard contract, and streaming protection", () => {
  let host: HTMLDivElement;
  let root: Root;
  let clipboardWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetHighlightHtmlCache();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
  });

  function render(node: ReturnType<typeof createElement>): void {
    act(() => {
      root.render(node);
    });
  }

  it("folds settled collapsible blocks > 20 lines to 8 preview lines, copies full source, and toggles expand/collapse", async () => {
    const fullCode = makeLines(25);
    render(
      createElement(CodeBlock, {
        code: `${fullCode}\n`,
        lang: "ts",
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );

    const block = host.querySelector(".md-code-block");
    expect(block?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);
    expect(host.querySelector("pre")?.textContent).not.toContain("const line_25");

    const toggle = host.querySelector<HTMLButtonElement>("[data-code-fold-toggle]");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("25");

    // Clicking copy while folded must copy the complete trimmed source, not the 8-line preview.
    const copyButton = host.querySelector<HTMLButtonElement>("[data-code-block-banner] button");
    expect(copyButton).not.toBeNull();
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardWrite).toHaveBeenCalledWith(fullCode);

    // Expanding renders and highlights all 25 lines.
    act(() => {
      toggle?.click();
    });
    expect(block?.getAttribute("data-code-folded")).toBe("false");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(25);
    expect(host.querySelector("pre")?.textContent).toContain("const line_25");

    // Collapsing again restores the 8-line preview.
    act(() => {
      toggle?.click();
    });
    expect(block?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);
  });

  it("does not fold blocks at or below FOLD_LINE_THRESHOLD", () => {
    const exactThresholdCode = makeLines(FOLD_LINE_THRESHOLD);
    render(
      createElement(CodeBlock, {
        code: `${exactThresholdCode}\n`,
        lang: "ts",
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );

    expect(host.querySelector("[data-code-fold-toggle]")).toBeNull();
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_LINE_THRESHOLD);
  });

  it("keeps streaming long blocks unfolded and preserves expanded state after streaming settles", () => {
    const growingCode = makeLines(25);
    render(
      createElement(CodeBlock, {
        code: `${growingCode}\n`,
        lang: "ts",
        streaming: true,
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );

    expect(host.querySelector("[data-code-fold-toggle]")).toBeNull();
    expect(host.querySelectorAll("pre code .line")).toHaveLength(25);

    // Transitioning streaming -> false must NOT snap the block shut.
    render(
      createElement(CodeBlock, {
        code: `${growingCode}\n`,
        lang: "ts",
        streaming: false,
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );

    const block = host.querySelector(".md-code-block");
    expect(block?.getAttribute("data-code-folded")).toBe("false");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(25);

    // User can still collapse manually once settled.
    const toggle = host.querySelector<HTMLButtonElement>("[data-code-fold-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      toggle?.click();
    });
    expect(block?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);

    // Resuming streaming on a collapsed block expands it and keeps it expanded once settled again.
    render(
      createElement(CodeBlock, {
        code: `${growingCode}\nconst line_26 = 26;\n`,
        lang: "ts",
        streaming: true,
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );
    expect(host.querySelectorAll("pre code .line")).toHaveLength(26);
    render(
      createElement(CodeBlock, {
        code: `${growingCode}\nconst line_26 = 26;\n`,
        lang: "ts",
        streaming: false,
        collapsible: true,
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );
    expect(block?.getAttribute("data-code-folded")).toBe("false");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(26);
  });

  it("renders oversized blocks as plain monospace text without Shiki markup and still copies full text", async () => {
    const oversized = Array.from({ length: MAX_HIGHLIGHT_LINES + 1 }, (_, i) => `l${i}`).join("\n");
    render(
      createElement(CodeBlock, {
        code: `${oversized}\n`,
        lang: "ts",
        copyLabel: "Copy",
        copiedLabel: "Copied",
      }),
    );

    const pre = host.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.classList.contains("shiki")).toBe(false);
    expect(pre?.textContent).toBe(oversized);

    const copyButton = host.querySelector<HTMLButtonElement>("[data-code-block-banner] button");
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledWith(oversized);
  });

  it("enables folding for MarkdownText inside MarkdownDelegateProvider without affecting standalone line-numbered CodeBlock", () => {
    const longCode = makeLines(24);
    render(
      createElement(
        "div",
        null,
        createElement(
          MarkdownDelegateProvider,
          {
            collapsibleCodeBlocks: true,
            expandCodeLabel: (count: number) => `展开全部（共 ${count} 行）`,
            collapseCodeLabel: "收起代码",
          },
          createElement(MarkdownText, {
            text: `\`\`\`ts\n${longCode}\n\`\`\``,
            labels: {
              code: { copyLabel: "Copy", copiedLabel: "Copied" },
              footnotes: "Footnotes",
            },
          }),
        ),
        createElement(CodeBlock, {
          code: `${longCode}\n`,
          lang: "ts",
          lineNumbers: true,
          copyLabel: "Copy",
          copiedLabel: "Copied",
        }),
      ),
    );

    const blocks = host.querySelectorAll(".md-code-block");
    expect(blocks).toHaveLength(2);
    // Markdown fence inside provider is folded with localized label.
    expect(blocks[0]?.getAttribute("data-code-folded")).toBe("true");
    expect(blocks[0]?.querySelector("[data-code-fold-toggle]")?.textContent).toContain(
      "展开全部（共 24 行）",
    );
    // Standalone line-numbered CodeBlock outside provider is not folded.
    expect(blocks[1]?.getAttribute("data-code-folded")).toBeNull();
    expect(blocks[1]?.querySelector("[data-code-fold-toggle]")).toBeNull();
  });

  it("preserves user-expanded and collapsed state across virtualized unmount/remount via CodeBlockFoldMemoryProvider", () => {
    const longCode = makeLines(26);
    const memory = new Map<string, boolean>();
    const mountRow = (mounted: boolean, scope = "row-1") =>
      render(
        createElement(
          MarkdownDelegateProvider,
          { collapsibleCodeBlocks: true },
          mounted
            ? createElement(
                CodeBlockFoldMemoryProvider,
                { key: scope, memory, scope },
                createElement(MarkdownText, {
                  text: `\`\`\`ts\n${longCode}\n\`\`\``,
                  labels: {
                    code: { copyLabel: "Copy", copiedLabel: "Copied" },
                    footnotes: "Footnotes",
                  },
                }),
              )
            : null,
        ),
      );

    // 1. Starts folded on initial mount.
    mountRow(true);
    expect(host.querySelector(".md-code-block")?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);

    // 2. User expands the code block.
    act(() => {
      host.querySelector<HTMLButtonElement>("[data-code-fold-toggle]")?.click();
    });
    expect(host.querySelector(".md-code-block")?.getAttribute("data-code-folded")).toBe("false");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(26);

    // 3. Simulate virtualized unmount then remount: block stays expanded with full lines.
    mountRow(false);
    expect(host.querySelector(".md-code-block")).toBeNull();
    mountRow(true);
    expect(host.querySelector(".md-code-block")?.getAttribute("data-code-folded")).toBe("false");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(26);

    // 4. Another row scope with identical code starts folded independently.
    mountRow(true, "row-2");
    expect(host.querySelector(".md-code-block")?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);

    // 5. Collapsing row-1 persists across another unmount/remount cycle.
    mountRow(true, "row-1");
    act(() => {
      host.querySelector<HTMLButtonElement>("[data-code-fold-toggle]")?.click();
    });
    mountRow(false, "row-1");
    mountRow(true, "row-1");
    expect(host.querySelector(".md-code-block")?.getAttribute("data-code-folded")).toBe("true");
    expect(host.querySelectorAll("pre code .line")).toHaveLength(FOLD_PREVIEW_LINES);
  });
});
