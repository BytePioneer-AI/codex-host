import { expect, it, vi } from "vitest";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";
import {
  ChatNavigation,
  type ChatNavigationInput,
} from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/use-chat-navigation.ts";
import type { ChatViewport } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/use-chat-viewport.ts";
import type { ChatReading } from "../../../apps/web-ui/packages/client/ui-chat/src/client/chat/use-chat-reading.ts";

function fixture() {
  const viewport = {
    readScroll: () => ({ metrics: { top: 0 } }),
    stopPreserving: vi.fn(),
    beginPaging: vi.fn(),
    scrollToTurn: vi.fn(() => null),
  };
  const input: ChatNavigationInput = {
    historyReady: false,
    firstSeq: 100,
    hasMore: true,
    loadingOlder: false,
    olderFailed: false,
    loadOlder: vi.fn(),
    loadThrough: vi.fn(async () => {}),
  };
  const navigation = new ChatNavigation(
    viewport as unknown as ChatViewport,
    { pauseFollowing: vi.fn() } as unknown as ChatReading,
    input,
    vi.fn(),
  );
  return { navigation, input, viewport };
}

it("does not latch a cached head before history is ready, then pages normally at that same head", () => {
  const { navigation, input, viewport } = fixture();
  navigation.autoLoadEarlier();
  navigation.loadEarlier();
  navigation.navigateToTurn({
    turn: 1,
    prompt: "",
    response: "",
    anchor: { kind: "unloaded", seq: SessionSeq(1) },
  });
  expect(input.loadOlder).not.toHaveBeenCalled();
  expect(input.loadThrough).not.toHaveBeenCalled();
  expect(viewport.beginPaging).not.toHaveBeenCalled();
  navigation.setInput({ ...input, historyReady: true });
  navigation.autoLoadEarlier();
  navigation.autoLoadEarlier();
  expect(input.loadOlder).toHaveBeenCalledTimes(1);
});

it("allows navigation within loaded cached content without paging", () => {
  const { navigation, input, viewport } = fixture();
  navigation.navigateToTurn({
    turn: 4,
    prompt: "",
    response: "",
    anchor: { kind: "loaded", key: "cached-turn" },
  });
  expect(viewport.scrollToTurn).toHaveBeenCalledWith(4);
  expect(input.loadThrough).not.toHaveBeenCalled();
});
