// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatNavigation } from "../src/client/chat/use-chat-navigation.ts";
import {
  ChatReading,
  type ChatReadingState,
  type ReadingSample,
} from "../src/client/chat/use-chat-reading.ts";
import { ChatViewport } from "../src/client/chat/use-chat-viewport.ts";
import { ScrollFollow } from "../src/client/chat/use-scroll-follow.ts";
import type { ChatScrollPosition } from "../src/client/contract/slots.ts";

interface MockScrollerDom {
  readonly scroller: HTMLDivElement;
  readonly list: HTMLDivElement;
  readonly column: HTMLDivElement;
  readonly rows: HTMLDivElement[];
  readonly composerSeat: HTMLDivElement;
  readonly composerEditor: HTMLDivElement;
  getScrollTop: () => number;
  setScrollTop: (value: number) => void;
  setRowTopOffset: (delta: number) => void;
  setScrollHeight: (value: number) => void;
  cleanup: () => void;
}

function createMockScrollerDom(rowCount = 5): MockScrollerDom {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-conversation-scroll", "");
  const list = document.createElement("div");
  const column = document.createElement("div");
  const composerSeat = document.createElement("div");
  composerSeat.setAttribute("data-composer-seat", "");
  const composerEditor = document.createElement("div");
  composerEditor.setAttribute("contenteditable", "true");
  composerSeat.append(composerEditor);
  list.append(column);
  scroller.append(list, composerSeat);
  document.body.append(scroller);

  let scrollTop = 200;
  let scrollHeight = 2000;
  const clientHeight = 600;
  let prependOffset = 0;

  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      const floor = Math.max(0, scrollHeight - clientHeight);
      scrollTop = Math.max(0, Math.min(floor, value));
    },
  });
  Object.defineProperty(scroller, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        top: 0,
        bottom: clientHeight,
        left: 0,
        right: 800,
        width: 800,
        height: clientHeight,
      }) as DOMRect,
  });
  Object.defineProperty(list, "clientWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(list, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        top: -scrollTop,
        bottom: scrollHeight - scrollTop,
        left: 0,
        right: 800,
        width: 800,
        height: scrollHeight,
      }) as DOMRect,
  });

  // Composer editor at bottom/top edge (non-overflowing single line)
  Object.defineProperty(composerEditor, "clientHeight", { configurable: true, value: 40 });
  Object.defineProperty(composerEditor, "scrollHeight", { configurable: true, value: 40 });
  Object.defineProperty(composerEditor, "scrollTop", { configurable: true, value: 0 });

  const rows: HTMLDivElement[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const row = document.createElement("div");
    row.setAttribute("data-chat-flow-key", `node-${i}`);
    row.setAttribute("data-chat-anchor-key", `node-${i}`);
    row.setAttribute("data-chat-node-key", `node-${i}`);
    row.setAttribute("data-chat-paging-anchor", "");
    row.setAttribute("data-chat-turn", String(i + 1));
    row.textContent = `Row ${i}`;
    const docTop = 100 + i * 200;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = docTop + prependOffset - scrollTop;
        return {
          top,
          bottom: top + 160,
          left: 0,
          right: 800,
          width: 800,
          height: 160,
        } as DOMRect;
      },
    });
    column.append(row);
    rows.push(row);
  }

  return {
    scroller,
    list,
    column,
    rows,
    composerSeat,
    composerEditor,
    getScrollTop: () => scrollTop,
    setScrollTop: (value: number) => {
      scrollTop = value;
    },
    setRowTopOffset: (delta: number) => {
      prependOffset += delta;
      scrollHeight += delta;
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value;
    },
    cleanup: () => {
      scroller.remove();
    },
  };
}

describe("chat scroll paging anchor, wheel intent, and reading sample latching", () => {
  let dom: MockScrollerDom;
  let originalRO: typeof ResizeObserver;
  let roCallbacks: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    roCallbacks = [];
    originalRO = globalThis.ResizeObserver;
    class MockResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        roCallbacks.push(() => callback([], this));
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    dom = createMockScrollerDom(6);
  });

  afterEach(() => {
    dom.cleanup();
    globalThis.ResizeObserver = originalRO;
    vi.useRealTimers();
  });

  it("never reverts user downward scroll when a ResizeObserver fires while a paging anchor is retained, yet preserves pure prepend anchoring", () => {
    const viewport = new ChatViewport();
    viewport.attach(dom.list, dom.column);
    try {
      // Initial acknowledged position at scrollTop = 200; row-0 is at docTop = 100 -> viewport top = -100.
      viewport.acknowledge({ top: 200, floor: 1400, height: 600 });
      viewport.beginPaging();
      expect(viewport.preserving).toBe(true);

      // Pure prepend: 400px of older rows inserted above row-0 while scrollTop stays 200.
      dom.setRowTopOffset(400);
      const prependLanding = viewport.preserve();
      expect(prependLanding).not.toBeNull();
      expect(dom.getScrollTop()).toBe(600);
      expect(viewport.preserving).toBe(true);

      // Now reader scrolls down from 600 -> 880 BEFORE onScroll/onIntent runs, and a resize hits preserve().
      dom.setScrollTop(880);
      const reverted = viewport.preserve();
      expect(reverted).toBeNull();
      expect(dom.getScrollTop()).toBe(880);
      expect(viewport.preserving).toBe(false);
      // observation.top was NOT clobbered to 600/880, so subsequent readScroll still sees movedByReader=true.
      expect(viewport.readScroll()?.movedByReader).toBe(true);
    } finally {
      viewport.detach();
    }
  });

  it("releases a retained paging anchor on downward wheel over the composer seat when editor is at its scroll edge", () => {
    const viewport = new ChatViewport();
    const interact = vi.fn();
    viewport.attach(dom.list, dom.column);
    const disconnect = viewport.connect({
      scroll: () => {},
      scrollEnd: () => {},
      resize: () => {},
      interact,
      olderIntent: () => {},
    });
    try {
      viewport.acknowledge({ top: 200, floor: 1400, height: 600 });
      viewport.beginPaging();
      expect(viewport.preserving).toBe(true);

      // Wheel down on composer editor at its bottom edge (which view-binding forwards to scroller).
      dom.composerEditor.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 160, bubbles: true, cancelable: true }),
      );
      expect(viewport.preserving).toBe(false);
      expect(interact).toHaveBeenCalledTimes(1);

      // Non-wheel keydown inside composer still does NOT cancel paging.
      viewport.beginPaging();
      expect(viewport.preserving).toBe(true);
      dom.composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      expect(viewport.preserving).toBe(true);
    } finally {
      disconnect();
      viewport.detach();
    }
  });

  it("latches movedByReader across a ChatReading sampling window even if a later event brings scrollTop back near baseline", () => {
    const viewport = new ChatViewport();
    viewport.attach(dom.list, dom.column);
    let saved: ChatScrollPosition | null = null;
    const store = {
      read: () => saved,
      save: (pos: ChatScrollPosition | null) => {
        saved = pos;
      },
    };
    const follow = new ScrollFollow(false, 25);
    let state: ChatReadingState = { initialized: true, followingTail: false, activeTurn: 1 };
    const reading = new ChatReading(
      viewport,
      store,
      state,
      (next) => {
        state = next;
      },
      follow,
    );
    const samples: ReadingSample[] = [];
    const disconnectReading = reading.connect((sample) => samples.push(sample));
    const navigation = new ChatNavigation(
      viewport,
      reading,
      {
        historyReady: true,
        firstSeq: 10,
        hasMore: true,
        loadingOlder: false,
        olderFailed: false,
        loadOlder: () => {},
        loadThrough: async () => {},
      },
      () => {},
    );
    const disconnectViewport = viewport.connect({
      scroll: (scroll) => reading.onScroll(scroll),
      scrollEnd: () => {
        reading.onScrollEnd();
        navigation.readerSettled();
      },
      resize: () => {
        if (!navigation.contentCommitted()) reading.onResize();
        navigation.reconcile();
      },
      interact: () => navigation.cancel(),
      olderIntent: () => {},
    });

    try {
      viewport.acknowledge({ top: 200, floor: 1400, height: 600 });
      viewport.beginPaging();
      expect(viewport.preserving).toBe(true);

      // Reader scrolls down to 450 (movedByReader = true) -> starts 500ms sampling timer.
      dom.setScrollTop(450);
      dom.scroller.dispatchEvent(new Event("scroll"));
      expect(reading.pending).toBe(true);

      // Even if observation baseline is later shifted/matched before the timer fires,
      // the latched movedByReader must still report movedByReader: true when flushed.
      viewport.acknowledge({ top: 450, floor: 1400, height: 600 });
      vi.advanceTimersByTime(500);

      expect(samples).toHaveLength(1);
      expect(samples[0]?.movedByReader).toBe(true);
    } finally {
      disconnectViewport();
      disconnectReading();
      reading.dispose();
      navigation.dispose();
      viewport.detach();
    }
  });

  it("publishes --dsh-chat-viewport-width on the chat list element without requiring container-type on .frame", () => {
    const viewport = new ChatViewport();
    viewport.attach(dom.list, dom.column);
    try {
      expect(dom.list.style.getPropertyValue("--dsh-chat-viewport-width")).toBe("800px");
    } finally {
      viewport.detach();
    }
    expect(dom.list.style.getPropertyValue("--dsh-chat-viewport-width")).toBe("");
  });
});
