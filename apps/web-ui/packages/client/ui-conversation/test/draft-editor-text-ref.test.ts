import { $getRoot } from "lexical";
import { describe, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { DraftEditorRuntime } from "../src/client/input/editor/runtime.ts";
import { rescanTextRefs, TextRefNode } from "../src/client/input/editor/text-ref.ts";

type Lexicon = ReadonlyMap<"/" | "@" | "#", readonly string[]>;

function createRuntime(initialLexicon: Lexicon = new Map()) {
  const lexiconStore = createSnapshotStore<Lexicon>(initialLexicon);
  const runtime = new DraftEditorRuntime({
    onUpdate: () => {
      runtime.refreshProjection();
    },
    openReference: () => false,
    activeClaimToken: () => null,
    lexicon: () => lexiconStore.getSnapshot(),
    resolveLexicon: () => lexiconStore,
  });
  const dispose = runtime.register();
  return { runtime, lexiconStore, dispose };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("rescanTextRefs", () => {
  it("skips dirtying plain text nodes without trigger characters", async () => {
    const { runtime, dispose } = createRuntime();
    try {
      runtime.setDraft("这是一段普通的中文文本");
      const onEditorCommit = vi.fn();
      const off = runtime.editor.registerUpdateListener(onEditorCommit);
      try {
        rescanTextRefs(runtime.editor);
        await flushMicrotasks();
        expect(onEditorCommit).not.toHaveBeenCalled();
      } finally {
        off();
      }
    } finally {
      dispose();
    }
  });

  it("re-scans trigger text into TextRefNode and reverts it back when the lexicon changes", async () => {
    const { runtime, lexiconStore, dispose } = createRuntime(new Map());
    try {
      runtime.refreshLexiconSubscription();
      runtime.setDraft("run /plan now");

      const refTexts = () =>
        runtime.editor.getEditorState().read(() =>
          $getRoot()
            .getAllTextNodes()
            .filter((node) => node instanceof TextRefNode)
            .map((node) => node.getTextContent()),
        );

      expect(refTexts()).toEqual([]);

      lexiconStore.set(new Map([["/", ["plan"]]]));
      await flushMicrotasks();
      expect(refTexts()).toEqual(["/plan"]);

      lexiconStore.set(new Map());
      await flushMicrotasks();
      expect(refTexts()).toEqual([]);
    } finally {
      dispose();
    }
  });
});
