// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useTurnFileChanges } from "@deepseek-ai/dsh-client-ui-chat/src/client/chat/turn-file-changes.ts";
import type { ChatNodeStore } from "@deepseek-ai/dsh-client-ui-chat/src/client/contract/snapshot.ts";
import type { ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/src/client/contract/slots.ts";
import type { DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";

const a = { path: "a.ts", oldText: "old A", newText: "new A" };
const b = { path: "b.ts", oldText: "old B", newText: "new B" };
const again = { path: "a.ts", oldText: "new A", newText: "final A" };
const blocks = [a, b, again].map((diff) => ({ meta: { diffs: [diff] } }));

afterEach(() => vi.unstubAllGlobals());

describe("Turn file summaries", () => {
  it("uses the independent cumulative summary, including an empty reverted summary", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const tools = blocks.map((root) => ({ root }));
    const turnDataSource = vi.fn(() => ({ subscribe: () => () => {}, getSnapshot: () => tools }));
    const store = { turnDataSource } as unknown as ChatNodeStore;
    let summary: Readonly<Record<string, readonly DiffHunk[]>> | undefined;
    const useProjection = ((_key: string, select: (value: typeof summary) => unknown) =>
      select(summary)) as ChatViewSlotProps["useProjection"];
    const host = document.createElement("div");
    const root = createRoot(host);
    function View({ turn }: { turn: number }) {
      const files = useTurnFileChanges(store, turn, useProjection);
      return createElement(
        "pre",
        null,
        JSON.stringify(files.map((file) => ({ path: file.path, hunks: file.hunks }))),
      );
    }
    try {
      act(() => root.render(createElement(View, { turn: 1 })));
      expect(JSON.parse(host.textContent ?? "")[0].hunks).toEqual([again]);
      summary = { 1: [{ ...a, newText: "final A" }, b], 2: [b] };
      act(() => root.render(createElement(View, { turn: 1 })));
      expect(JSON.parse(host.textContent ?? "")[0].hunks).toEqual([{ ...a, newText: "final A" }]);
      summary = { ...summary, 1: [] };
      act(() => root.render(createElement(View, { turn: 1 })));
      expect(host.textContent).toBe("[]");
      act(() => root.render(createElement(View, { turn: 2 })));
      expect(JSON.parse(host.textContent ?? "")).toEqual([{ path: "b.ts", hunks: [b] }]);
    } finally {
      act(() => root.unmount());
    }
  });
});
