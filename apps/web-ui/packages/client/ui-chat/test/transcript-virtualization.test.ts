// @vitest-environment jsdom

import React, { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  GroupKey,
  GroupSnapshot,
  NodeKey,
  RenderEntry,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatPresentationPolicy } from "../src/client/presentation-policy.ts";
import type { ChatConversationViewNode } from "../src/client/contract/chat-nodes.ts";
import type { ChatSnapshot, ChatTurnProcessPresentation } from "../src/client/contract/snapshot.ts";
import type { ChatViewSlotProps } from "../src/client/contract/slots.ts";
import type { ChatStoreState } from "../src/client/contract/store.ts";
import type { ProcessGroupData } from "../src/client/contract/process-groups.ts";
import { ChatNodeSeat } from "../src/client/chat/ChatNodeSeat.tsx";
import { ChatGroupSeat } from "../src/client/chat/ChatGroupSeat.tsx";
import {
  ESTIMATED_NODE_HEIGHT,
  FIND_LEASE_TIMEOUT_MS,
  PIN_TAIL,
  VIRTUALIZE_THRESHOLD,
  entryFlowKey,
  flowKeyForAnswerKey,
  useTranscriptVirtualization,
  type NavigationPinTarget,
  type TranscriptVirtualization,
} from "../src/client/chat/use-transcript-virtualization.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MockIOInstance {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  readonly observed: Set<Element>;
  emit: (entries: Array<{ target: Element; isIntersecting: boolean; height?: number }>) => void;
}

function installMockIntersectionObserver(): {
  instances: MockIOInstance[];
  restore: () => void;
} {
  const original = globalThis.IntersectionObserver;
  const instances: MockIOInstance[] = [];

  class MockIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: ReadonlyArray<number> = [0];
    readonly observed = new Set<Element>();
    readonly callback: IntersectionObserverCallback;
    readonly options: IntersectionObserverInit | undefined;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.options = options;
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? "0px";
      instances.push(this);
    }

    observe(target: Element): void {
      this.observed.add(target);
    }

    unobserve(target: Element): void {
      this.observed.delete(target);
    }

    disconnect(): void {
      this.observed.clear();
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }

    emit(items: Array<{ target: Element; isIntersecting: boolean; height?: number }>): void {
      const entries = items.map((item) => {
        const height = item.height ?? 0;
        const rect = {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: height,
          right: 600,
          width: 600,
          height,
          toJSON: () => ({}),
        } as DOMRectReadOnly;
        return {
          target: item.target,
          isIntersecting: item.isIntersecting,
          intersectionRatio: item.isIntersecting ? 1 : 0,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          time: Date.now(),
        } as IntersectionObserverEntry;
      });
      this.callback(entries, this);
    }
  }

  globalThis.IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
  return {
    instances,
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

function mockRowHeight(element: HTMLElement, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: height,
        right: 600,
        width: 600,
        height,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

function makeUserNode(index: number, turn = index + 1): ChatConversationViewNode {
  const key = `node-${index}` as NodeKey;
  return {
    id: key,
    key,
    kind: "user",
    anchorSeq: index + 1,
    location: {
      kind: "turn",
      turn: {
        turn,
        status: "closed",
        data: createSnapshotStore({}),
      },
    },
    data: {
      seq: index + 1,
      content: [{ type: "text", text: `Message ${index}` }],
    },
  } as unknown as ChatConversationViewNode;
}

function makeAssistantProcessNode(
  keyStr: string,
  turn: number,
  seq: number,
  step: number,
): ChatConversationViewNode {
  const key = keyStr as NodeKey;
  return {
    id: key,
    key,
    kind: "assistant-step",
    anchorSeq: seq,
    location: {
      kind: "step",
      turn: {
        turn,
        status: "closed",
        data: createSnapshotStore({}),
      },
    },
    data: {
      step,
      status: "done",
      blocks: [{ kind: "text", text: `Step ${step}` }],
    },
  } as unknown as ChatConversationViewNode;
}

function createFakeSeatEnvironment(
  nodes: ReadonlyMap<string, ChatConversationViewNode>,
  options?: {
    processes?: ReadonlyMap<string, ChatTurnProcessPresentation>;
    groups?: ReadonlyMap<string, GroupSnapshot<ProcessGroupData>>;
    foldCompletedTurns?: boolean;
  },
) {
  const emptyUsers = createSnapshotStore<readonly unknown[]>([]);
  const nodeStore: ChatSnapshot["nodes"] = {
    get: (key: string) => nodes.get(key),
    turnDataSource: () => emptyUsers,
  } as unknown as ChatSnapshot["nodes"];

  const policy: ChatPresentationPolicy = {
    foldCompletedTurns: options?.foldCompletedTurns ?? false,
    stepGrouping: "collapsed",
    liveProcessDetail: false,
  } as unknown as ChatPresentationPolicy;

  const storeState: ChatStoreState = {
    turnProcesses: [],
  } as unknown as ChatStoreState;

  const useChatNode: ChatViewSlotProps["useChatNode"] = ((
    key: string,
    selector?: (node: ChatConversationViewNode | undefined) => unknown,
  ) => {
    const node = nodes.get(key);
    return selector ? selector(node) : node;
  }) as ChatViewSlotProps["useChatNode"];

  const useChatNodeProcess: ChatViewSlotProps["useChatNodeProcess"] = ((
    key: string,
    selector?: (p: ChatTurnProcessPresentation | undefined) => unknown,
  ) => {
    const proc = options?.processes?.get(key);
    return selector ? selector(proc) : proc;
  }) as ChatViewSlotProps["useChatNodeProcess"];

  const useChatGroup: ChatViewSlotProps["useChatGroup"] = ((
    key: string,
    selector?: (g: GroupSnapshot<ProcessGroupData> | undefined) => unknown,
  ) => {
    const group = options?.groups?.get(key);
    return selector ? selector(group) : group;
  }) as ChatViewSlotProps["useChatGroup"];

  const usePresentation: ChatViewSlotProps["usePresentation"] = ((
    selector: (p: ChatPresentationPolicy) => unknown,
  ) => selector(policy)) as ChatViewSlotProps["usePresentation"];

  const useStore: ChatViewSlotProps["useStore"] = ((
    selector: (s: Readonly<ChatStoreState>) => unknown,
  ) => selector(storeState)) as ChatViewSlotProps["useStore"];

  const renderSlot: ChatViewSlotProps["renderSlot"] = ((
    _slot: string,
    owner: { node: ChatConversationViewNode },
  ) =>
    createElement(
      "div",
      { "data-rendered-body": owner.node.key },
      createElement("p", null, `Body of ${owner.node.key}`),
      createElement("button", { type: "button", "data-focus-target": owner.node.key }, "Focus"),
    )) as unknown as ChatViewSlotProps["renderSlot"];

  const seatProps = {
    nodeStore,
    useChatNode,
    useChatNodeProcess,
    useChatGroup,
    usePresentation,
    useStore,
    actions: { setTurnProcessOpen: vi.fn() } as unknown as ChatViewSlotProps["actions"],
    openFile: vi.fn(),
    openSkill: vi.fn(),
    inspectCall: undefined,
    forkAt: vi.fn(),
    loadImage: vi.fn(),
    renderMessageImages: vi.fn(() => null),
    fileMentions: vi.fn(() => undefined),
    renderSlot,
    t: ((key: string) => key) as unknown as ChatViewSlotProps["t"],
  };

  return { nodeStore, seatProps };
}

interface HarnessProps {
  sessionId: string;
  entries: readonly RenderEntry[];
  nodes: ReadonlyMap<string, ChatConversationViewNode>;
  processes?: ReadonlyMap<string, ChatTurnProcessPresentation>;
  groups?: ReadonlyMap<string, GroupSnapshot<ProcessGroupData>>;
  foldCompletedTurns?: boolean;
  editingFlowKey?: string | null;
  revealTargetFlowKey?: string | null;
  savedAnchorFlowKey?: string | null;
  busyTurn?: number | null;
  findLeaseTimeoutMs?: number;
  withConversationScroll?: boolean;
  onHandle?: (handle: TranscriptVirtualization) => void;
}

function VirtualizedTranscriptHarness({
  sessionId,
  entries,
  nodes,
  processes,
  groups,
  foldCompletedTurns,
  editingFlowKey = null,
  revealTargetFlowKey = null,
  savedAnchorFlowKey = null,
  busyTurn = null,
  findLeaseTimeoutMs,
  withConversationScroll = true,
  onHandle,
}: HarnessProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const { nodeStore, seatProps } = createFakeSeatEnvironment(nodes, {
    processes,
    groups,
    foldCompletedTurns,
  });

  const virtualization = useTranscriptVirtualization({
    sessionId,
    entries,
    nodeStore,
    listRef,
    columnRef,
    editingFlowKey,
    revealTargetFlowKey,
    savedAnchorFlowKey,
    busyTurn,
    findLeaseTimeoutMs,
  });
  onHandle?.(virtualization);

  const registerRow = virtualization.active ? virtualization.registerRow : undefined;

  return createElement(
    "div",
    withConversationScroll ? { "data-conversation-scroll": "" } : null,
    createElement(
      "div",
      { ref: listRef },
      createElement(
        "div",
        { ref: columnRef, "data-chat-flow": "" },
        entries.map((entry, index) => {
          const flowKey = entryFlowKey(entry);
          const mounted = virtualization.isMounted(index, flowKey);
          const placeholderHeight = mounted
            ? undefined
            : virtualization.placeholderHeight(flowKey, entry.kind);
          if (entry.kind === "group") {
            return createElement(ChatGroupSeat, {
              ...seatProps,
              key: `group:${entry.key}`,
              groupKey: entry.key,
              mounted,
              placeholderHeight,
              registerRow,
            });
          }
          return createElement(ChatNodeSeat, {
            ...seatProps,
            key: `node:${entry.key}:${entry.groupPart ?? ""}`,
            nodeKey: entry.key,
            groupPart: entry.groupPart,
            mounted,
            placeholderHeight,
            registerRow,
          });
        }),
      ),
    ),
  );
}

function buildEntries(count: number): {
  entries: RenderEntry[];
  nodes: Map<string, ChatConversationViewNode>;
} {
  const entries: RenderEntry[] = [];
  const nodes = new Map<string, ChatConversationViewNode>();
  for (let i = 0; i < count; i += 1) {
    const node = makeUserNode(i, i + 1);
    nodes.set(node.key, node);
    entries.push({ kind: "node", key: node.key as NodeKey });
  }
  return { entries, nodes };
}

function findVirtualizationIO(instances: MockIOInstance[]): MockIOInstance | undefined {
  return instances.findLast((instance) => instance.options?.rootMargin === "150% 0px");
}

describe("transcript row-shell content virtualization and find lease", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mockIO: ReturnType<typeof installMockIntersectionObserver>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockIO = installMockIntersectionObserver();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    mockIO.restore();
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  it("mounts all entries without virtualization when entries.length <= VIRTUALIZE_THRESHOLD", async () => {
    const { entries, nodes } = buildEntries(VIRTUALIZE_THRESHOLD);
    let handle: TranscriptVirtualization | undefined;

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-short",
          entries,
          nodes,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });

    expect(handle?.active).toBe(false);
    expect(findVirtualizationIO(mockIO.instances)).toBeUndefined();
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(VIRTUALIZE_THRESHOLD);
    expect(container.querySelectorAll("[data-chat-virtualized]")).toHaveLength(0);
  });

  it("unmounts offscreen rows above threshold while keeping outer shells, measured heights, and zero-height hidden members", async () => {
    const total = VIRTUALIZE_THRESHOLD + 12; // 60 entries
    const { entries, nodes } = buildEntries(total);

    // Replace index 2 with a folded (hidden) turn-process member and index 3 with a folded (hidden) process group.
    const hiddenMemberKey = "node-hidden-member" as NodeKey;
    const hiddenMemberNode = makeAssistantProcessNode(hiddenMemberKey, 2, 100, 1);
    nodes.set(hiddenMemberKey, hiddenMemberNode);
    entries[2] = { kind: "node", key: hiddenMemberKey };

    const hiddenGroupMemberKey = "node-group-member" as NodeKey;
    const hiddenGroupMember = makeAssistantProcessNode(hiddenGroupMemberKey, 3, 200, 1);
    nodes.set(hiddenGroupMemberKey, hiddenGroupMember);

    const hiddenGroupKey = "group-hidden" as GroupKey;
    const visibleGroupMemberKey = "node-visible-group-member" as NodeKey;
    const visibleGroupMember = makeAssistantProcessNode(visibleGroupMemberKey, 4, 300, 1);
    nodes.set(visibleGroupMemberKey, visibleGroupMember);
    const visibleGroupKey = "group-visible" as GroupKey;

    entries[3] = { kind: "group", key: hiddenGroupKey };
    entries[4] = { kind: "group", key: visibleGroupKey };

    const processes = new Map<string, ChatTurnProcessPresentation>([
      [
        hiddenMemberKey,
        {
          turn: 2,
          turnStarted: true,
          turnClosed: true,
          hasExternalProcess: true,
          hasInterleavedInput: false,
          compactAnswer: false,
          spec: { turn: 2, answerStep: 2, processStartSeq: 1, inlineReasoning: false },
        },
      ],
      [
        hiddenGroupMemberKey,
        {
          turn: 3,
          turnStarted: true,
          turnClosed: true,
          hasExternalProcess: true,
          hasInterleavedInput: false,
          compactAnswer: false,
          spec: { turn: 3, answerStep: 2, processStartSeq: 1, inlineReasoning: false },
        },
      ],
    ]);

    const groups = new Map<string, GroupSnapshot<ProcessGroupData>>([
      [
        hiddenGroupKey,
        {
          key: hiddenGroupKey,
          members: [{ kind: "node", key: hiddenGroupMemberKey }],
          data: { turn: 3, closed: true, summary: { counts: [] } },
        },
      ],
      [
        visibleGroupKey,
        {
          key: visibleGroupKey,
          members: [{ kind: "node", key: visibleGroupMemberKey }],
          data: { turn: 4, closed: true, summary: { counts: [] } },
        },
      ],
    ]);

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-long",
          entries,
          nodes,
          processes,
          groups,
          foldCompletedTurns: true,
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances);
    expect(io).toBeDefined();
    expect(io?.options?.rootMargin).toBe("150% 0px");

    // All 60 top-level shells remain in the DOM with their data-chat-* attributes.
    const row0 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-0"]')!;
    const hiddenMemberRow = container.querySelector<HTMLElement>(
      `[data-chat-flow-key="${hiddenMemberKey}"]`,
    )!;
    const hiddenGroupRow = container.querySelector<HTMLElement>(
      `[data-chat-flow-key="${hiddenGroupKey}"]`,
    )!;
    const visibleGroupRow = container.querySelector<HTMLElement>(
      `[data-chat-flow-key="${visibleGroupKey}"]`,
    )!;

    expect(row0).not.toBeNull();
    expect(row0.dataset.chatAnchorKey).toBe("node-0");
    expect(row0.dataset.chatTurn).toBe("1");
    expect(row0.querySelector("[data-rendered-body]")).toBeNull();
    expect(row0.style.minHeight).toBe(`${ESTIMATED_NODE_HEIGHT}px`);
    expect(row0.hasAttribute("data-chat-virtualized")).toBe(true);

    // Folded hidden member and folded hidden group stay hidden with NO blank placeholder height!
    expect(hiddenMemberRow.getAttribute("hidden")).toBe("until-found");
    expect(hiddenMemberRow.style.minHeight).toBe("");
    expect(hiddenMemberRow.hasAttribute("data-chat-virtualized")).toBe(false);

    expect(hiddenGroupRow.getAttribute("hidden")).toBe("until-found");
    expect(hiddenGroupRow.style.minHeight).toBe("");
    expect(hiddenGroupRow.hasAttribute("data-chat-virtualized")).toBe(false);

    // Bring row 0 and visibleGroupRow into viewport: content mounts (including nested group members).
    await act(async () => {
      io!.emit([
        { target: row0, isIntersecting: true },
        { target: visibleGroupRow, isIntersecting: true },
      ]);
    });
    expect(row0.querySelector('[data-rendered-body="node-0"]')).not.toBeNull();
    expect(row0.style.minHeight).toBe("");
    expect(
      visibleGroupRow.querySelector(`[data-rendered-body="${visibleGroupMemberKey}"]`),
    ).not.toBeNull();

    // Scroll row 0 out of viewport with measured height 216px: content unmounts and shell keeps 216px min-height.
    mockRowHeight(row0, 216);
    await act(async () => {
      io!.emit([{ target: row0, isIntersecting: false, height: 216 }]);
    });
    expect(row0.querySelector("[data-rendered-body]")).toBeNull();
    expect(row0.style.minHeight).toBe("216px");
    expect(row0.hasAttribute("data-chat-virtualized")).toBe(true);
  });

  it("pins tail entries, cross-row selections, focused rows, editing rows, and jump targets offscreen", async () => {
    const total = 60;
    const { entries, nodes } = buildEntries(total);
    let handle!: TranscriptVirtualization;

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-pins",
          entries,
          nodes,
          editingFlowKey: "node-12",
          revealTargetFlowKey: flowKeyForAnswerKey(JSON.stringify(["node-18", "response"])),
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;

    // 1. Tail PIN_TAIL (indices 50..59) stay mounted even when IO reports non-intersecting.
    const tailElements = Array.from({ length: PIN_TAIL }, (_, offset) => {
      const idx = total - PIN_TAIL + offset;
      return container.querySelector<HTMLElement>(`[data-chat-flow-key="node-${idx}"]`)!;
    });
    await act(async () => {
      io.emit(tailElements.map((target) => ({ target, isIntersecting: false, height: 100 })));
    });
    for (const el of tailElements) {
      expect(el.querySelector("[data-rendered-body]")).not.toBeNull();
    }

    // 2. Editing row (node-12) and viewRequest reveal target (node-18) stay mounted offscreen.
    expect(
      container.querySelector('[data-chat-flow-key="node-12"] [data-rendered-body="node-12"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-chat-flow-key="node-18"] [data-rendered-body="node-18"]'),
    ).not.toBeNull();

    // 3. Explicit Turn navigation target pins the target row offscreen.
    expect(
      container.querySelector('[data-chat-flow-key="node-25"] [data-rendered-body]'),
    ).toBeNull();
    const target: NavigationPinTarget = { turn: 26, anchorKey: "node-25" };
    await act(async () => {
      handle.pinNavigationTarget(target);
    });
    expect(
      container.querySelector('[data-chat-flow-key="node-25"] [data-rendered-body="node-25"]'),
    ).not.toBeNull();

    // 4. Cross-row selection spanning rows 5..8 pins start, end, and every row in between.
    const row5 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-5"]')!;
    const row6 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-6"]')!;
    const row7 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-7"]')!;
    const row8 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-8"]')!;
    await act(async () => {
      io.emit([
        { target: row5, isIntersecting: true },
        { target: row6, isIntersecting: true },
        { target: row7, isIntersecting: true },
        { target: row8, isIntersecting: true },
      ]);
    });
    const startText = row5.querySelector("p")!.firstChild!;
    const endText = row8.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(startText, 0);
    range.setEnd(endText, endText.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    // Scroll rows 5..8 out of viewport: all four must remain mounted to keep selection intact.
    mockRowHeight(row6, 150);
    await act(async () => {
      io.emit([
        { target: row5, isIntersecting: false, height: 140 },
        { target: row6, isIntersecting: false, height: 150 },
        { target: row7, isIntersecting: false, height: 160 },
        { target: row8, isIntersecting: false, height: 170 },
      ]);
    });
    expect(row5.querySelector('[data-rendered-body="node-5"]')).not.toBeNull();
    expect(row6.querySelector('[data-rendered-body="node-6"]')).not.toBeNull();
    expect(row7.querySelector('[data-rendered-body="node-7"]')).not.toBeNull();
    expect(row8.querySelector('[data-rendered-body="node-8"]')).not.toBeNull();

    // Clearing selection unmounts offscreen rows 5..8 while retaining their measured heights.
    selection.removeAllRanges();
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(row6.querySelector("[data-rendered-body]")).toBeNull();
    expect(row6.style.minHeight).toBe("150px");

    // 5. Focused element inside row 2 pins row 2 while offscreen, then releases on focusout.
    const row2 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-2"]')!;
    await act(async () => {
      io.emit([{ target: row2, isIntersecting: true }]);
    });
    const focusButton = row2.querySelector<HTMLButtonElement>('[data-focus-target="node-2"]')!;
    await act(async () => {
      focusButton.focus();
      focusButton.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    mockRowHeight(row2, 132);
    await act(async () => {
      io.emit([{ target: row2, isIntersecting: false, height: 132 }]);
    });
    expect(row2.querySelector('[data-rendered-body="node-2"]')).not.toBeNull();

    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    try {
      await act(async () => {
        focusButton.dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget: outsideButton }),
        );
      });
      expect(row2.querySelector("[data-rendered-body]")).toBeNull();
      expect(row2.style.minHeight).toBe("132px");
    } finally {
      outsideButton.remove();
    }
  });

  it("activates full-mount lease on Cmd+F / Ctrl+F without preventDefault and releases on Escape, timeout, or session switch", async () => {
    vi.useFakeTimers();
    const total = 56;
    const { entries, nodes } = buildEntries(total);
    let handle!: TranscriptVirtualization;

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-find-1",
          entries,
          nodes,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });

    // Initially only tail 10 entries are mounted.
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);
    expect(handle.findLeaseActive).toBe(false);

    // Cmd+F activates lease immediately and MUST NOT prevent default native find.
    const cmdF = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(cmdF);
    });
    expect(cmdF.defaultPrevented).toBe(false);
    expect(handle.findLeaseActive).toBe(true);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(total);

    // Measure one offscreen row before lease releases.
    const row3 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-3"]')!;
    mockRowHeight(row3, 192);

    // Escape releases the lease immediately (without preventDefault) and restores virtualization.
    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(false);
    expect(handle.findLeaseActive).toBe(false);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);
    expect(row3.style.minHeight).toBe("192px");

    // Ctrl+F activates lease again; activity extends timeout; idle timeout releases lease.
    const ctrlF = new KeyboardEvent("keydown", {
      key: "F",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(ctrlF);
    });
    expect(ctrlF.defaultPrevented).toBe(false);
    expect(handle.findLeaseActive).toBe(true);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(total);

    // Activity on find-navigation keys (e.g. non-editable Enter, Cmd+G, F3) extends the 30s timer.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      vi.advanceTimersByTime(20_000);
    });
    expect(handle.findLeaseActive).toBe(true);

    // Ordinary non-find keystrokes must NOT indefinitely extend the lease.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      vi.advanceTimersByTime(16_000);
    });
    expect(handle.findLeaseActive).toBe(false);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);

    // Focusing an editable composer input immediately releases an active find lease.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }),
      );
    });
    expect(handle.findLeaseActive).toBe(true);
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    try {
      await act(async () => {
        composer.focus();
        composer.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      expect(handle.findLeaseActive).toBe(false);
      expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);
    } finally {
      composer.remove();
    }

    // Switching sessionId resets lease and cached measured heights.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }),
      );
    });
    expect(handle.findLeaseActive).toBe(true);

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-find-2",
          entries,
          nodes,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });
    expect(handle.findLeaseActive).toBe(false);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);
    const nextSessionRow3 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-3"]')!;
    expect(nextSessionRow3.style.minHeight).toBe(`${ESTIMATED_NODE_HEIGHT}px`);
  });

  it("gracefully mounts all rows when IntersectionObserver is unavailable", async () => {
    const originalIO = globalThis.IntersectionObserver;
    // @ts-expect-error simulating environment without IntersectionObserver
    globalThis.IntersectionObserver = undefined;
    try {
      const { entries, nodes } = buildEntries(VIRTUALIZE_THRESHOLD + 10);
      let handle: TranscriptVirtualization | undefined;
      await act(async () => {
        root.render(
          createElement(VirtualizedTranscriptHarness, {
            sessionId: "s-no-io",
            entries,
            nodes,
            withConversationScroll: false,
            onHandle: (h) => {
              handle = h;
            },
          }),
        );
      });
      expect(handle?.active).toBe(false);
      expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(
        VIRTUALIZE_THRESHOLD + 10,
      );
    } finally {
      globalThis.IntersectionObserver = originalIO;
    }
  });
});
