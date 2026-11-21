import { $getRoot, $isLineBreakNode, $isParagraphNode } from "lexical";
import { describe, expect, it } from "vitest";
import { DraftEditorRuntime } from "../src/client/input/editor/runtime.ts";

function createRuntime(): { runtime: DraftEditorRuntime; dispose: () => void } {
  const emptyLexicon = new Map<"/" | "@" | "#", readonly string[]>();
  const runtime = new DraftEditorRuntime({
    onUpdate: () => {
      runtime.refreshProjection();
    },
    openReference: () => false,
    activeClaimToken: () => null,
    lexicon: () => emptyLexicon,
    resolveLexicon: () => undefined,
  });
  const dispose = runtime.register();
  return { runtime, dispose };
}

function inspectNodes(runtime: DraftEditorRuntime): {
  rawNewlineTextNodes: string[];
  lineBreakCount: number;
} {
  return runtime.editor.getEditorState().read(() => {
    const root = $getRoot();
    const rawNewlineTextNodes = root
      .getAllTextNodes()
      .map((node) => node.getTextContent())
      .filter((text) => /[\r\n]/u.test(text));
    let lineBreakCount = 0;
    for (const block of root.getChildren()) {
      if (!$isParagraphNode(block)) continue;
      for (const child of block.getChildren()) {
        if ($isLineBreakNode(child)) lineBreakCount += 1;
      }
    }
    return { rawNewlineTextNodes, lineBreakCount };
  });
}

describe("DraftEditorRuntime multiline insertion", () => {
  it.each([
    {
      label: "trailing LF on unfocused editor",
      seed: null,
      text: "第一行\n第二行\n第三行\n",
      expectedDraft: "第一行\n第二行\n第三行\n",
      expectedLineBreaks: 3,
    },
    {
      label: "CRLF inside existing draft",
      seed: "前缀",
      text: "第一行\r\n第二行\r\n",
      expectedDraft: "前缀第一行\n第二行\n",
      expectedLineBreaks: 2,
    },
  ])(
    "converts pasted newlines into LineBreakNodes ($label)",
    ({ seed, text, expectedDraft, expectedLineBreaks }) => {
      const { runtime, dispose } = createRuntime();
      try {
        if (seed !== null) runtime.setDraft(seed);
        runtime.paste(text);

        expect(runtime.projection.detectText).toBe(expectedDraft);
        expect(runtime.projection.clipboardText).toBe(expectedDraft);
        expect(runtime.projection.caret).toBe(expectedDraft.length);
        expect(inspectNodes(runtime)).toEqual({
          rawNewlineTextNodes: [],
          lineBreakCount: expectedLineBreaks,
        });
      } finally {
        dispose();
      }
    },
  );

  it("converts multiline async insertions into LineBreakNodes without affecting single-line replacements", () => {
    const { runtime, dispose } = createRuntime();
    try {
      runtime.setDraft("开头结尾");
      expect(runtime.insertAsyncText({ start: 2, end: 2 }, "第一行\r\n第二行\n")).toBe(true);
      expect(runtime.projection.clipboardText).toBe("开头第一行\n第二行\n结尾");
      expect(inspectNodes(runtime)).toEqual({
        rawNewlineTextNodes: [],
        lineBreakCount: 2,
      });

      expect(runtime.replaceText({ start: 0, end: 2 }, "/plan ")).toBe(true);
      expect(runtime.projection.clipboardText).toBe("/plan 第一行\n第二行\n结尾");
      expect(runtime.replaceText({ start: 0, end: 6 }, "")).toBe(true);
      expect(runtime.projection.clipboardText).toBe("第一行\n第二行\n结尾");
    } finally {
      dispose();
    }
  });
});
