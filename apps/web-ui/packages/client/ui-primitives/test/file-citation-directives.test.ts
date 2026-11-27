// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Root as MdastRoot } from "mdast";
import { parseGfmWithMath } from "../src/markdown/parse.ts";
import { extractMarkdownPlainText } from "../src/markdown/plain-text.ts";
import { MarkdownText, type MarkdownLabels } from "../src/markdown/MarkdownText.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: MarkdownLabels = {
  code: {
    copyLabel: "Copy",
    copiedLabel: "Copied",
    toolbarLabels: { codeLabel: "Code", wrapLabel: "Wrap", unwrapLabel: "Unwrap" },
  },
  footnotes: "Footnotes",
};

function firstChildOf(markdown: string): MdastRoot["children"][number] | undefined {
  const root: MdastRoot = parseGfmWithMath(markdown);
  const paragraph = root.children[0];
  if (paragraph?.type !== "paragraph") return undefined;
  return paragraph.children[0];
}

describe("file-citation directive grammar", () => {
  it("parses a quoted path with an optional purpose", () => {
    expect(
      firstChildOf(':codex-file-citation{path="C:/example/source.pdf" purpose="source"}'),
    ).toMatchObject({
      type: "codexFileCitation",
      path: "C:/example/source.pdf",
      purpose: "source",
    });
    expect(firstChildOf(':codex-file-citation{path="/tmp/notes.md"}')).toMatchObject({
      type: "codexFileCitation",
      path: "/tmp/notes.md",
    });
  });

  it("keeps annotation directives on the annotation node", () => {
    expect(firstChildOf(':codex-annotation{index="2"}')).toMatchObject({
      type: "codexAnnotation",
      index: "2",
    });
  });

  it("leaves a name-only colon fragment as plain text", () => {
    expect(firstChildOf(":codex-file-citation-not-a-directive")?.type).toBe("text");
  });

  it("projects an unresolvable citation as the path, not the marker", () => {
    expect(extractMarkdownPlainText('see :codex-file-citation{path="notes.md"} here')).toContain(
      "notes.md",
    );
    expect(
      extractMarkdownPlainText('see :codex-file-citation{path="notes.md"} here'),
    ).not.toContain(":codex-file-citation");
  });
});

describe("file-citation rendering", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it("renders a resolvable citation as the opener button for the cited path", () => {
    const open = vi.fn();
    act(() => {
      root.render(
        createElement(MarkdownText, {
          text: 'Read :codex-file-citation{path="C:/example/source.pdf" purpose="source"} for details.',
          labels: LABELS,
          fileCitations: {
            resolve: () => ({
              open,
              label: "C:/example/source.pdf",
              title: "C:/example/source.pdf",
            }),
          },
        }),
      );
    });
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("C:/example/source.pdf");
    expect(button!.getAttribute("title")).toBe("C:/example/source.pdf");
    act(() => {
      button!.click();
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("keeps the raw marker text when no citation vocabulary exists", () => {
    act(() => {
      root.render(
        createElement(MarkdownText, {
          text: ':codex-file-citation{path="C:/example/source.pdf" purpose="source"}',
          labels: LABELS,
        }),
      );
    });
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain(
      ':codex-file-citation{path="C:/example/source.pdf" purpose="source"}',
    );
  });
});
