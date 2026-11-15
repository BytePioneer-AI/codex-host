// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { useTurnAnnotations } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/turn-annotations.ts";
import { EMPTY_CHAT_SNAPSHOT } from "../../../apps/web-ui/packages/client/ui-chat/src/client/contract/snapshot.ts";
import type { ChatNodeDataMap } from "../../../apps/web-ui/packages/client/ui-chat/src/client/contract/chat-nodes.ts";

// Include the message-kind declarations used by the Chat store.
import type {} from "../../../apps/web-ui/packages/client/ui-chat/src/client/conversation-nodes/message.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("resolves top-level user annotations only, updates them, and unsubscribes", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const user = (text: string): ChatNodeDataMap["user"] => ({
    kind: "user",
    seq: 1,
    time: 0,
    source: null,
    content: [],
    responseAnnotations: [{ text }],
  });
  const users = createSnapshotStore<readonly ChatNodeDataMap["user"][]>([user("first")]);
  const off = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    const unsubscribe = users.subscribe(listener);
    return () => {
      off();
      unsubscribe();
    };
  });
  const turnDataSource = vi.spyOn(EMPTY_CHAT_SNAPSHOT.nodes, "turnDataSource").mockReturnValue({
    getSnapshot: users.getSnapshot,
    subscribe,
  });
  const store = EMPTY_CHAT_SNAPSHOT.nodes;
  const host = document.createElement("div");
  const root = createRoot(host);
  function View({ turn }: { turn?: number }) {
    return createElement("pre", null, JSON.stringify(useTurnAnnotations(store, turn)));
  }
  try {
    act(() => root.render(createElement(View, { turn: 1 })));
    expect(host.textContent).toBe('[{"text":"first"}]');
    expect(turnDataSource).toHaveBeenCalledExactlyOnceWith(1, "user");
    act(() => users.set([user("updated")]));
    expect(host.textContent).toBe('[{"text":"updated"}]');
    act(() => users.set([{ kind: "user", seq: 1, time: 0, source: null, content: [] }]));
    expect(host.textContent).toBe("[]");
    act(() => root.render(createElement(View)));
    expect(host.textContent).toBe("[]");
    expect(off).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});
