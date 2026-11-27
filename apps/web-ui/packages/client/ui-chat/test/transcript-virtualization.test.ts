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
import { ChatViewport } from "../src/client/chat/use-chat-viewport.ts";
import {
  ESTIMATED_NODE_HEIGHT,
  FIND_LEASE_MAX_DURATION_MS,
  FIND_LEASE_TIMEOUT_MS,
  PIN_TAIL,
  VIRTUALIZE_OVERSCAN_MARGIN,
  VIRTUALIZE_THRESHOLD,
  computeOverscanMargin,
  entryFlowKey,
  flowKeyForAnswerKey,
  resolveRevealTargetFlowKey,
  resolveSelectionFlowRange,
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
  findLeaseMaxDurationMs?: number;
  overscanMargin?: string;
  withConversationScroll?: boolean;
  followingTail?: boolean;
  onTailScrollClamp?: () => void;
  onScrollCompensated?: (delta: number) => void;
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
  findLeaseMaxDurationMs,
  overscanMargin,
  withConversationScroll = true,
  followingTail = false,
  onTailScrollClamp,
  onScrollCompensated,
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
    findLeaseMaxDurationMs,
    overscanMargin,
    onTailScrollClamp,
    onScrollCompensated,
  });
  onHandle?.(virtualization);

  const registerRow = virtualization.active ? virtualization.registerRow : undefined;

  return createElement(
    "div",
    withConversationScroll ? { "data-conversation-scroll": "" } : null,
    createElement(
      "div",
      followingTail ? { "data-chat-following-tail": "" } : null,
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
  return instances.findLast((instance) => instance.options?.rootMargin?.endsWith("px 0px"));
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
    expect(io?.options?.rootMargin).toBe(VIRTUALIZE_OVERSCAN_MARGIN);

    // Before the first IO callback settles, rows stay mounted (no white flash) while shells register.
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

    expect(row0.querySelector('[data-rendered-body="node-0"]')).not.toBeNull();
    expect(io?.observed.has(row0)).toBe(true);

    // First IO callback settles virtualization and unmounts offscreen rows.
    await act(async () => {
      io!.emit([{ target: row0, isIntersecting: false }]);
    });

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

    const io = findVirtualizationIO(mockIO.instances)!;
    // Before first IO callback settles, all rows remain mounted.
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(total);
    await act(async () => {
      io.emit([
        {
          target: container.querySelector<HTMLElement>('[data-chat-flow-key="node-0"]')!,
          isIntersecting: false,
        },
      ]);
    });

    // After first IO callback, only tail 10 entries are mounted.
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
    // Session switch resets ioSettled so the new session stays mounted until its first IO settles.
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(total);
    const nextIo = findVirtualizationIO(mockIO.instances)!;
    const nextSessionRow3 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-3"]')!;
    await act(async () => {
      nextIo.emit([{ target: nextSessionRow3, isIntersecting: false }]);
    });
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);
    expect(nextSessionRow3.style.minHeight).toBe(`${ESTIMATED_NODE_HEIGHT}px`);
  });

  it("renews native-find lease on passive scroll and non-collapsed selectionchange up to the hard cap, and resets when disabled", async () => {
    vi.useFakeTimers();
    const total = 56;
    const { entries, nodes } = buildEntries(total);
    let handle!: TranscriptVirtualization;

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-find-renew",
          entries,
          nodes,
          findLeaseMaxDurationMs: 75_000,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });
    const io = findVirtualizationIO(mockIO.instances)!;
    await act(async () => {
      io.emit([
        {
          target: container.querySelector<HTMLElement>('[data-chat-flow-key="node-0"]')!,
          isIntersecting: false,
        },
      ]);
    });
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(PIN_TAIL);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }),
      );
    });
    expect(handle.findLeaseActive).toBe(true);

    // Passive scroll on the scrollport extends the 30s idle window.
    const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    await act(async () => {
      vi.advanceTimersByTime(25_000);
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(20_000);
    });
    expect(handle.findLeaseActive).toBe(true);

    // Non-collapsed selectionchange renews; collapsed selectionchange does not.
    const row0Text = container.querySelector('[data-chat-flow-key="node-0"] p')!.firstChild!;
    const range = document.createRange();
    range.setStart(row0Text, 0);
    range.setEnd(row0Text, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      document.dispatchEvent(new Event("selectionchange"));
      vi.advanceTimersByTime(5_000);
    });
    expect(handle.findLeaseActive).toBe(true);

    // Hard duration ceiling (75s from Cmd+F; 70s elapsed so far) terminates sliding renewals.
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(handle.findLeaseActive).toBe(false);
    expect(FIND_LEASE_MAX_DURATION_MS).toBe(180_000);
    selection.removeAllRanges();

    // Dropping below VIRTUALIZE_THRESHOLD while find lease is active resets findLeaseState.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }),
      );
    });
    expect(handle.findLeaseActive).toBe(true);

    const short = buildEntries(20);
    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-find-renew",
          entries: short.entries,
          nodes: short.nodes,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });
    expect(handle.active).toBe(false);
    expect(handle.findLeaseActive).toBe(false);

    // Crossing the threshold again starts clean without a stuck lease and stays mounted until first IO.
    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-find-renew",
          entries,
          nodes,
          onHandle: (h) => {
            handle = h;
          },
        }),
      );
    });
    expect(handle.active).toBe(true);
    expect(handle.findLeaseActive).toBe(false);
    expect(container.querySelectorAll("[data-rendered-body]")).toHaveLength(total);
  });

  it("handles Cmd+A (selectNode(column)) and downward selection past column bottom without clamping to row 0", () => {
    const outer = document.createElement("div");
    const before = document.createElement("div");
    before.textContent = "before";
    const column = document.createElement("div");
    const after = document.createElement("div");
    after.textContent = "after";
    outer.append(before, column, after);
    document.body.append(outer);

    try {
      const flowKeys: string[] = [];
      const flowKeyToIndex = new Map<string, number>();
      for (let i = 0; i < 6; i += 1) {
        const key = `node-${i}`;
        const row = document.createElement("div");
        row.setAttribute("data-chat-flow-key", key);
        row.textContent = `Row ${i}`;
        column.append(row);
        flowKeys.push(key);
        flowKeyToIndex.set(key, i);
      }

      const selection = window.getSelection()!;

      // 1. Cmd+A / selectNode(column) selects all rows 0..5.
      const selectAll = document.createRange();
      selectAll.selectNode(column);
      selection.removeAllRanges();
      selection.addRange(selectAll);
      expect(resolveSelectionFlowRange(selection, column, flowKeys, flowKeyToIndex)).toEqual({
        startKey: "node-0",
        endKey: "node-5",
      });

      // 2. Dragging from row 3 past bottom into ancestor `outer` (after column) clamps end to row 5, NOT 0.
      const dragPastBottom = document.createRange();
      dragPastBottom.setStart(column.children[3]!.firstChild!, 0);
      dragPastBottom.setEnd(outer, 3);
      selection.removeAllRanges();
      selection.addRange(dragPastBottom);
      expect(resolveSelectionFlowRange(selection, column, flowKeys, flowKeyToIndex)).toEqual({
        startKey: "node-3",
        endKey: "node-5",
      });

      // 3. Dragging from ancestor `outer` offset 0 into row 2 clamps start to row 0.
      const dragFromTop = document.createRange();
      dragFromTop.setStart(outer, 0);
      dragFromTop.setEnd(column.children[2]!.firstChild!, 3);
      selection.removeAllRanges();
      selection.addRange(dragFromTop);
      expect(resolveSelectionFlowRange(selection, column, flowKeys, flowKeyToIndex)).toEqual({
        startKey: "node-0",
        endKey: "node-2",
      });

      // 4. Selection entirely outside column returns null.
      const outsideOnly = document.createRange();
      outsideOnly.selectNodeContents(after);
      selection.removeAllRanges();
      selection.addRange(outsideOnly);
      expect(resolveSelectionFlowRange(selection, column, flowKeys, flowKeyToIndex)).toBeNull();
    } finally {
      outer.remove();
    }
  });

  it("avoids O(N) reflow on scroll, preserves RO heights over stale IO callbacks, and computes pixel overscan from root height", async () => {
    const originalRO = globalThis.ResizeObserver;
    const roRecords: Array<{
      callback: ResizeObserverCallback;
      observed: Set<Element>;
    }> = [];
    class MockResizeObserver implements ResizeObserver {
      readonly observed = new Set<Element>();
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        roRecords.push({ callback, observed: this.observed });
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
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

    try {
      const total = 55;
      const { entries, nodes } = buildEntries(total);
      let handle!: TranscriptVirtualization;

      await act(async () => {
        root.render(
          createElement(VirtualizedTranscriptHarness, {
            sessionId: "s-perf",
            entries,
            nodes,
            onHandle: (h) => {
              handle = h;
            },
          }),
        );
      });

      // Verify pixel overscan helper and explicit overscanMargin override.
      expect(computeOverscanMargin(600)).toBe("960px 0px");
      const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
      const rootRo = roRecords.find((r) => r.observed.has(scroller));
      expect(rootRo).toBeDefined();
      await act(async () => {
        rootRo!.callback(
          [{ target: scroller, contentRect: { height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
      const resizedIo = findVirtualizationIO(mockIO.instances)!;
      expect(resizedIo.options?.rootMargin).toBe("960px 0px");

      // Settle IO with row 5 visible and row 0 offscreen.
      const row0 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-0"]')!;
      const row5 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-5"]')!;
      const row6 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-6"]')!;
      await act(async () => {
        resizedIo.emit([
          { target: row0, isIntersecting: false },
          { target: row5, isIntersecting: true },
        ]);
      });

      // Record RO height 320px for row5, then emit stale offscreen IO height 180px: RO value must win.
      const rowRo = roRecords.find((r) => r.observed.has(row5));
      expect(rowRo).toBeDefined();
      await act(async () => {
        rowRo!.callback(
          [
            {
              target: row5,
              borderBoxSize: [{ blockSize: 320 }],
              contentRect: { height: 320 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      await act(async () => {
        resizedIo.emit([{ target: row5, isIntersecting: false, height: 180 }]);
      });
      expect(row5.style.minHeight).toBe("320px");

      // While virtualizing, mounting a new row (row6) must NOT re-measure already-observed mounted rows (tail).
      const tailRow = container.querySelector<HTMLElement>('[data-chat-flow-key="node-54"]')!;
      const rectSpy = vi.fn(() => ({ height: 90, top: 0, bottom: 90 }) as DOMRect);
      Object.defineProperty(tailRow, "getBoundingClientRect", {
        configurable: true,
        value: rectSpy,
      });
      await act(async () => {
        rowRo!.callback(
          [
            {
              target: tailRow,
              borderBoxSize: [{ blockSize: 90 }],
              contentRect: { height: 90 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      rectSpy.mockClear();
      await act(async () => {
        resizedIo.emit([{ target: row6, isIntersecting: true }]);
      });
      expect(rectSpy).not.toHaveBeenCalled();

      // While !virtualizing (findLeaseActive), IO visibleKeys churn keeps isMounted identity stable.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }),
        );
      });
      const stableIsMounted = handle.isMounted;
      await act(async () => {
        resizedIo.emit([{ target: row0, isIntersecting: true }]);
      });
      expect(handle.isMounted).toBe(stableIsMounted);

      // Explicit overscanMargin always takes precedence over root height.
      await act(async () => {
        root.render(
          createElement(VirtualizedTranscriptHarness, {
            sessionId: "s-perf",
            entries,
            nodes,
            overscanMargin: "500px 0px",
          }),
        );
      });
      expect(findVirtualizationIO(mockIO.instances)?.options?.rootMargin).toBe("500px 0px");
    } finally {
      globalThis.ResizeObserver = originalRO;
    }
  });

  it("compensates scrollTop when above-viewport rows expand on engines without overflow-anchor, without disturbing tail-follow", async () => {
    const total = 56;
    const { entries, nodes } = buildEntries(total);

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-anchor-comp",
          entries,
          nodes,
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;
    const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const row2 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-2"]')!;
    const row10 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-10"]')!;

    // Settle IO with row10 in viewport and row2 offscreen above.
    await act(async () => {
      io.emit([{ target: row10, isIntersecting: true }]);
    });
    expect(row2.querySelector("[data-rendered-body]")).toBeNull();
    expect(row10.querySelector("[data-rendered-body]")).not.toBeNull();

    // Configure scroller away from bottom: scrollHeight=5000, clientHeight=600, scrollTop=1000.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    let scrollTopValue = 1000;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({ top: 0, bottom: 600, height: 600, left: 0, right: 600, width: 600 }) as DOMRect,
    });
    // Row 2 sits above viewport (top = -200); when it mounts, row 10 shifts from top=40 -> top=240 (+200px).
    Object.defineProperty(row2, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({ top: -200, bottom: -120, height: 80, left: 0, right: 600, width: 600 }) as DOMRect,
    });
    Object.defineProperty(row10, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const expanded = row2.querySelector("[data-rendered-body]") !== null;
        const top = expanded ? 240 : 40;
        return { top, bottom: top + 100, height: 100, left: 0, right: 600, width: 600 } as DOMRect;
      },
    });

    await act(async () => {
      io.emit([{ target: row2, isIntersecting: true }]);
    });
    expect(row2.querySelector("[data-rendered-body]")).not.toBeNull();
    expect(scrollTopValue).toBe(1200);
  });

  it("exempts [data-chat-virtualized] row shells from ChatViewport :empty checks during paging and fallback capture", () => {
    const scroller = document.createElement("div");
    scroller.setAttribute("data-conversation-scroll", "");
    const list = document.createElement("div");
    const column = document.createElement("div");
    scroller.append(list);
    list.append(column);
    document.body.append(scroller);

    try {
      const emptyNonVirtualized = document.createElement("div");
      emptyNonVirtualized.setAttribute("data-chat-flow-key", "empty-hidden");
      emptyNonVirtualized.setAttribute("data-chat-anchor-key", "empty-hidden");
      emptyNonVirtualized.setAttribute("data-chat-paging-anchor", "");

      const virtualizedShell = document.createElement("div");
      virtualizedShell.setAttribute("data-chat-flow-key", "node-0");
      virtualizedShell.setAttribute("data-chat-anchor-key", "node-0");
      virtualizedShell.setAttribute("data-chat-paging-anchor", "");
      virtualizedShell.setAttribute("data-chat-virtualized", "");
      virtualizedShell.style.minHeight = "120px";

      column.append(emptyNonVirtualized, virtualizedShell);

      Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
      Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        writable: true,
        value: 200,
      });
      Object.defineProperty(scroller, "getBoundingClientRect", {
        configurable: true,
        value: () =>
          ({ top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400 }) as DOMRect,
      });
      Object.defineProperty(virtualizedShell, "getBoundingClientRect", {
        configurable: true,
        value: () =>
          ({ top: 50, bottom: 170, left: 0, right: 600, width: 600, height: 120 }) as DOMRect,
      });

      const viewport = new ChatViewport();
      viewport.attach(list, column);
      try {
        // Fallback capturePosition skips ordinary :empty rows but keeps [data-chat-virtualized] shells.
        const captured = viewport.capturePosition();
        expect(captured?.anchorKey).toBe("node-0");

        // beginPaging selects the virtualized paging anchor and preserve() does not abort on it.
        viewport.beginPaging();
        expect(viewport.preserving).toBe(true);
        Object.defineProperty(virtualizedShell, "getBoundingClientRect", {
          configurable: true,
          value: () =>
            ({ top: 150, bottom: 270, left: 0, right: 600, width: 600, height: 120 }) as DOMRect,
        });
        const landing = viewport.preserve();
        expect(landing).not.toBeNull();
        expect(scroller.scrollTop).toBe(300);
      } finally {
        viewport.detach();
      }
    } finally {
      scroller.remove();
    }
  });

  it("maps grouped inner member answerKeys to their enclosing top-level groupKey for reveal pinning", () => {
    const groupKey = "group-1" as GroupKey;
    const memberKey = "node-step-2" as NodeKey;
    const entries: RenderEntry[] = [
      { kind: "node", key: "node-0" as NodeKey },
      { kind: "group", key: groupKey },
    ];
    const groupedView = {
      groupSource: (key: GroupKey) => ({
        getSnapshot: () =>
          key === groupKey
            ? { members: [{ kind: "node" as const, key: memberKey, groupPart: "response" }] }
            : undefined,
      }),
    };

    expect(resolveRevealTargetFlowKey(JSON.stringify(["node-0", null]), entries, groupedView)).toBe(
      "node-0",
    );
    expect(
      resolveRevealTargetFlowKey(JSON.stringify([memberKey, "response"]), entries, groupedView),
    ).toBe(groupKey);
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

  it("tracks empty direct conversation.chat.node slots with data-chat-empty and clears it on populate or virtualization", async () => {
    const node = makeUserNode(0, 1);
    const nodes = new Map<string, ChatConversationViewNode>([[node.key, node]]);
    const { seatProps } = createFakeSeatEnvironment(nodes);
    let setInnerVisible: ((visible: boolean) => void) | undefined;
    function DynamicSlotChild() {
      const [visible, setVisible] = React.useState(false);
      setInnerVisible = setVisible;
      return visible ? createElement("span", null, "dynamic-child") : null;
    }

    const renderSeat = (
      mounted: boolean,
      slotContent: React.ReactNode,
      placeholderHeight?: number,
    ) =>
      createElement(ChatNodeSeat, {
        ...seatProps,
        renderSlot: (() =>
          createElement(
            "div",
            { "data-slot": "conversation.chat.node" },
            slotContent,
          )) as unknown as ChatViewSlotProps["renderSlot"],
        nodeKey: node.key,
        mounted,
        placeholderHeight,
      });

    const dynamicNode = createElement(DynamicSlotChild);
    await act(async () => {
      root.render(renderSeat(true, dynamicNode));
    });
    const wrapper = container.querySelector<HTMLElement>(`[data-chat-flow-key="${node.key}"]`)!;
    const slot = wrapper.querySelector<HTMLElement>('[data-slot="conversation.chat.node"]')!;
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(true);

    // Comment-only slot content stays empty.
    await act(async () => {
      slot.appendChild(document.createComment("placeholder"));
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(true);

    // Autonomous slot-child updates (without ChatNodeSeat re-rendering) toggle data-chat-empty via MutationObserver.
    await act(async () => {
      setInnerVisible?.(true);
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(false);

    await act(async () => {
      setInnerVisible?.(false);
      await Promise.resolve();
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(true);

    // Synchronous ChatNodeSeat re-renders clear and restore data-chat-empty immediately.
    await act(async () => {
      root.render(renderSeat(true, createElement("div", null, "rendered")));
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(false);

    await act(async () => {
      root.render(renderSeat(true, null));
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(true);

    // Virtualizing the row clears data-chat-empty so placeholder shells keep height and gap.
    await act(async () => {
      root.render(renderSeat(false, null, 120));
    });
    expect(wrapper.hasAttribute("data-chat-empty")).toBe(false);
    expect(wrapper.hasAttribute("data-chat-virtualized")).toBe(true);
  });

  it("restores tail alignment via onTailScrollClamp when a tail-following virtualization commit clamps scrollTop", async () => {
    const total = VIRTUALIZE_THRESHOLD + 12;
    const { entries, nodes } = buildEntries(total);
    const onTailScrollClamp = vi.fn();

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-tail-clamp",
          entries,
          nodes,
          followingTail: true,
          onTailScrollClamp,
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;
    const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-flow-key]"));
    const row0 = rows[0]!;

    for (const row of rows) {
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 600, width: 600 }),
      });
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    let scrollTopValue = 4400;
    let simulatedClamp = false;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => {
        if (!simulatedClamp && row0.hasAttribute("data-chat-virtualized")) {
          simulatedClamp = true;
          scrollTopValue = 1800;
        }
        return scrollTopValue;
      },
      set: (value: number) => {
        scrollTopValue = value;
      },
    });
    onTailScrollClamp.mockImplementation(() => {
      scrollTopValue = 4400;
    });

    await act(async () => {
      io.emit(
        rows.map((row, index) => ({
          target: row,
          isIntersecting: index >= total - PIN_TAIL,
          height: 100,
        })),
      );
    });

    expect(row0.hasAttribute("data-chat-virtualized")).toBe(true);
    expect(onTailScrollClamp).toHaveBeenCalledTimes(1);
    expect(scrollTopValue).toBe(4400);
  });

  it("falls back to setting scrollTop to floor when onTailScrollClamp is omitted and skips clamp recovery when scrolled away", async () => {
    const total = VIRTUALIZE_THRESHOLD + 12;
    const { entries, nodes } = buildEntries(total);

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-tail-clamp-fallback",
          entries,
          nodes,
          followingTail: true,
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;
    const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-flow-key]"));
    const row0 = rows[0]!;

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 600 });
    let scrollTopValue = 4400;
    let simulatedClamp = false;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => {
        if (!simulatedClamp && row0.hasAttribute("data-chat-virtualized")) {
          simulatedClamp = true;
          scrollTopValue = 1200;
        }
        return scrollTopValue;
      },
      set: (value: number) => {
        scrollTopValue = value;
      },
    });

    await act(async () => {
      io.emit(
        rows.map((row, index) => ({
          target: row,
          isIntersecting: index >= total - PIN_TAIL,
          height: 100,
        })),
      );
    });
    expect(scrollTopValue).toBe(4400);

    // When scrolled away from the tail (even if followingTail attr lingers), never snap back to floor.
    const onTailScrollClamp = vi.fn();
    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-tail-away",
          entries,
          nodes,
          followingTail: true,
          onTailScrollClamp,
        }),
      );
    });
    const io2 = findVirtualizationIO(mockIO.instances)!;
    const scroller2 = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const rows2 = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-flow-key]"));
    Object.defineProperty(scroller2, "scrollHeight", { configurable: true, value: 5000 });
    Object.defineProperty(scroller2, "clientHeight", { configurable: true, value: 600 });
    let awayScrollTop = 1000;
    Object.defineProperty(scroller2, "scrollTop", {
      configurable: true,
      get: () => awayScrollTop,
      set: (value: number) => {
        awayScrollTop = value;
      },
    });

    await act(async () => {
      io2.emit(
        rows2.map((row, index) => ({
          target: row,
          isIntersecting: index >= 10 && index <= 20,
          height: 100,
        })),
      );
    });
    expect(onTailScrollClamp).not.toHaveBeenCalled();
    expect(awayScrollTop).toBe(1000);
  });

  it("samples fresh live DOM height with subpixel precision at unmount so height growth after caching never collapses the shell", async () => {
    const total = VIRTUALIZE_THRESHOLD + 12;
    const { entries, nodes } = buildEntries(total);

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-fresh-unmount",
          entries,
          nodes,
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;
    const row4 = container.querySelector<HTMLElement>('[data-chat-flow-key="node-4"]')!;

    // Initial mount height recorded as 120px when row4 first settles in viewport.
    mockRowHeight(row4, 120);
    await act(async () => {
      io.emit([{ target: row4, isIntersecting: true, height: 120 }]);
    });
    expect(row4.querySelector('[data-rendered-body="node-4"]')).not.toBeNull();

    // Row4 dynamically grows to 342.37px (e.g. image loaded or block expanded) before RO fires,
    // then leaves viewport and unmounts.
    mockRowHeight(row4, 342.37);
    await act(async () => {
      io.emit([{ target: row4, isIntersecting: false, height: 120 }]);
    });

    expect(row4.querySelector("[data-rendered-body]")).toBeNull();
    expect(row4.hasAttribute("data-chat-virtualized")).toBe(true);
    expect(row4.style.minHeight).toBe("342.37px");
  });

  it("advances scrollTop monotonically across downward unmount/mount batches and recovers from synchronous layout clamps", async () => {
    const total = 70;
    const { entries, nodes } = buildEntries(total);
    const compensatedDeltas: number[] = [];

    await act(async () => {
      root.render(
        createElement(VirtualizedTranscriptHarness, {
          sessionId: "s-monotonic-down",
          entries,
          nodes,
          onScrollCompensated: (delta) => {
            compensatedDeltas.push(delta);
          },
        }),
      );
    });

    const io = findVirtualizationIO(mockIO.instances)!;
    const scroller = container.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-flow-key]"));
    const clientHeight = 600;
    const mountedHeights = new Map<number, number>();
    for (let i = 0; i < total; i += 1) {
      mountedHeights.set(i, 180 + (i % 4) * 40);
    }

    const rowHeight = (index: number): number => {
      const row = rows[index]!;
      if (row.hasAttribute("data-chat-virtualized")) {
        const parsed = Number.parseFloat(row.style.minHeight);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : ESTIMATED_NODE_HEIGHT;
      }
      return mountedHeights.get(index) ?? 180;
    };

    const rowDocTop = (index: number): number => {
      let y = 0;
      for (let i = 0; i < index; i += 1) y += rowHeight(i);
      return y;
    };

    const totalHeight = (): number => {
      let h = 0;
      for (let i = 0; i < total; i += 1) h += rowHeight(i);
      return h;
    };

    let scrollTopValue = 400;
    let clampFired = false;
    const triggerRow = rows[4]!;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => totalHeight(),
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => {
        // Trigger once immediately after batch 2 commits row 4's unmount (simulating WebKit clamp).
        if (!clampFired && triggerRow.hasAttribute("data-chat-virtualized")) {
          clampFired = true;
          scrollTopValue = Math.max(0, scrollTopValue - 600);
        }
        return scrollTopValue;
      },
      set: (value: number) => {
        const floor = Math.max(0, totalHeight() - clientHeight);
        scrollTopValue = Math.max(0, Math.min(floor, value));
      },
    });
    Object.defineProperty(scroller, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({
          top: 0,
          bottom: clientHeight,
          height: clientHeight,
          left: 0,
          right: 600,
          width: 600,
        }) as DOMRect,
    });
    for (let i = 0; i < total; i += 1) {
      const idx = i;
      Object.defineProperty(rows[idx]!, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          const top = rowDocTop(idx) - scrollTopValue;
          const height = rowHeight(idx);
          return { top, bottom: top + height, height, left: 0, right: 600, width: 600 } as DOMRect;
        },
      });
    }

    // Settle initial viewport window around rows 0..14.
    await act(async () => {
      io.emit(
        rows.map((row, idx) => ({
          target: row,
          isIntersecting: idx <= 14,
          height: rowHeight(idx),
        })),
      );
    });

    // Walk downward in batches, simulating wheel increments + above-viewport unmounts + below-viewport mounts,
    // including a synchronous commit clamp on batch 2 (when row 4 unmounts).
    let previousTop = scrollTopValue;
    for (let batch = 1; batch <= 8; batch += 1) {
      const floor = totalHeight() - clientHeight;
      scrollTopValue = Math.min(floor, scrollTopValue + 900);
      const targetBeforeCommit = scrollTopValue;
      const windowStart = Math.min(total - PIN_TAIL, batch * 4);
      const windowEnd = Math.min(total - 1, windowStart + 14);
      await act(async () => {
        io.emit(
          rows.map((row, idx) => ({
            target: row,
            isIntersecting: idx >= windowStart && idx <= windowEnd,
            height: rowHeight(idx),
          })),
        );
      });
      // scrollTop must advance monotonically and never snap backward behind previousTop or targetBeforeCommit.
      expect(scrollTopValue).toBeGreaterThanOrEqual(previousTop);
      expect(scrollTopValue).toBeGreaterThanOrEqual(targetBeforeCommit - 1);
      previousTop = scrollTopValue;
    }
    expect(clampFired).toBe(true);
    expect(compensatedDeltas.some((delta) => delta >= 599)).toBe(true);
  });
});
