// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useTurnFileChanges } from "@deepseek-ai/dsh-client-ui-chat/src/client/chat/turn-file-changes.ts";
import type { ChatNodeStore } from "@deepseek-ai/dsh-client-ui-chat/src/client/contract/snapshot.ts";
import type { ChatViewSlotProps } from "@deepseek-ai/dsh-client-ui-chat/src/client/contract/slots.ts";
import { diffTotals } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WebTurnFileSummary } from "@codexhost/shared-contracts";
import { summarizeTurnDiffs } from "../../../packages/web-server/src/ch-turn-changes.ts";

const a = { path: "a.ts", oldText: "old A", newText: "new A" };
const b = { path: "b.ts", oldText: "old B", newText: "new B" };
const again = { path: "a.ts", oldText: "new A", newText: "final A" };
const blocks = [a, b, again].map((diff) => ({ meta: { diffs: [diff] } }));

afterEach(() => vi.unstubAllGlobals());

describe("Turn file summaries", () => {
  it("server summaries match the existing DiffBlock counts, including trailing newlines and bounded comparisons", () => {
    for (const diff of [
      a,
      { path: "new", oldText: null, newText: "one\ntwo\n" },
      { path: "deleted", oldText: "one\n\n", newText: "" },
      { path: "context", oldText: "shared\nold\nshared\n", newText: "shared\nnew\nshared\n" },
      {
        path: "bounded",
        oldText: Array.from({ length: 300 }, (_, i) => `old ${i}`).join("\n"),
        newText: Array.from({ length: 300 }, (_, i) => `new ${i}`).join("\n"),
      },
    ]) {
      const [summary] = summarizeTurnDiffs([diff]);
      expect({ added: summary?.added, removed: summary?.removed }).toEqual(diffTotals([diff]));
    }
  });
  it("uses the independent cumulative summary, including an empty reverted summary", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const tools = blocks.map((root) => ({ root }));
    const turnDataSource = vi.fn(() => ({ subscribe: () => () => {}, getSnapshot: () => tools }));
    const store = { turnDataSource } as unknown as ChatNodeStore;
    let summary: Readonly<Record<string, readonly WebTurnFileSummary[]>> | undefined;
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
      summary = {
        1: summarizeTurnDiffs([{ ...a, newText: "final A" }, b]),
        2: summarizeTurnDiffs([b]),
      };
      act(() => root.render(createElement(View, { turn: 1 })));
      expect(JSON.parse(host.textContent ?? "")).toEqual([{ path: "a.ts" }, { path: "b.ts" }]);
      summary = { ...summary, 1: [] };
      act(() => root.render(createElement(View, { turn: 1 })));
      expect(host.textContent).toBe("[]");
      act(() => root.render(createElement(View, { turn: 2 })));
      expect(JSON.parse(host.textContent ?? "")).toEqual([{ path: "b.ts" }]);
    } finally {
      act(() => root.unmount());
    }
  });
});
