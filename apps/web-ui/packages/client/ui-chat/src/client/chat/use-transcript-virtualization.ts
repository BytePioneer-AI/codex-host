/**
 * Row-shell content virtualization and native-find lease for long transcripts.
 * Keeps every top-level row shell (and its `data-chat-*` attributes) in the DOM
 * while unmounting offscreen heavy subtrees once the transcript exceeds the
 * threshold, preserving measured heights and protecting tail streaming, text
 * selections, focus/editing, navigation jumps, and native Cmd+F / Ctrl+F find.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { RenderEntry } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatSnapshot } from "../contract/snapshot.ts";

/** Minimum top-level entry count required before content virtualization activates. */
export const VIRTUALIZE_THRESHOLD = 48;
/** Number of newest top-level entries permanently pinned at the transcript tail. */
export const PIN_TAIL = 10;
/** Idle timeout before releasing a temporary native-find full-mount lease. */
export const FIND_LEASE_TIMEOUT_MS = 30_000;
/** IntersectionObserver rootMargin (~1.5 viewport heights above and below). */
export const VIRTUALIZE_OVERSCAN_MARGIN = "150% 0px";
/** Conservative placeholder height (px) for unmeasured node rows. */
export const ESTIMATED_NODE_HEIGHT = 80;
/** Conservative placeholder height (px) for unmeasured group rows. */
export const ESTIMATED_GROUP_HEIGHT = 32;
/** Extra following rows mounted alongside a jump target so the landing viewport renders immediately. */
const JUMP_TARGET_FOLLOWING_ROWS = 2;

/** Explicit navigation target pinned until superseded, reset, or session switch. */
export interface NavigationPinTarget {
  readonly turn: number | null;
  readonly anchorKey: string | null;
}

/** Inclusive selection span tracked by stable top-level flow keys. */
export interface SelectionFlowRange {
  readonly startKey: string;
  readonly endKey: string;
}

/** Inputs consumed by {@link useTranscriptVirtualization}. */
export interface TranscriptVirtualizationInput {
  readonly sessionId: string;
  readonly entries: readonly RenderEntry[];
  readonly nodeStore: ChatSnapshot["nodes"];
  readonly listRef: RefObject<HTMLElement | null>;
  readonly columnRef: RefObject<HTMLElement | null>;
  /** Flow key of the user message currently being edited inline. */
  readonly editingFlowKey?: string | null;
  /** Flow key of a response annotation target requested by `viewRequest`. */
  readonly revealTargetFlowKey?: string | null;
  /** Flow key of a saved scroll anchor being restored on initial open. */
  readonly savedAnchorFlowKey?: string | null;
  /** Turn currently being fetched by Turn navigation (`loadThrough`). */
  readonly busyTurn?: number | null;
  /** Override idle timeout for the native-find lease (defaults to {@link FIND_LEASE_TIMEOUT_MS}). */
  readonly findLeaseTimeoutMs?: number;
  /** Override IntersectionObserver rootMargin (defaults to {@link VIRTUALIZE_OVERSCAN_MARGIN}). */
  readonly overscanMargin?: string;
}

/** Per-render virtualization handle consumed by `ChatView` and `ChatNodeList`. */
export interface TranscriptVirtualization {
  /** Whether virtualization observers/hooks are active (`entries.length > 48` with IO support). */
  readonly active: boolean;
  /** Whether a temporary native-find full-mount lease is currently held. */
  readonly findLeaseActive: boolean;
  /** Whether the top-level entry at `index` should render its content subtree. */
  readonly isMounted: (index: number, flowKey: string) => boolean;
  /** Whether a loaded anchor key is already mounted in the current render. */
  readonly isAnchorMounted: (anchorKey: string) => boolean;
  /** Measured or conservative estimated placeholder height (px) for an unmounted row. */
  readonly placeholderHeight: (flowKey: string, kind: RenderEntry["kind"]) => number;
  /** Stable DOM element registration callback for top-level row shells. */
  readonly registerRow: (flowKey: string, element: HTMLDivElement | null) => void;
  /** Pin a Turn or anchor jump target before scrolling so it mounts immediately. */
  readonly pinNavigationTarget: (target: NavigationPinTarget | null) => void;
  /** Clear the explicit navigation pin (e.g. when returning to the tail). */
  readonly clearNavigationPin: () => void;
}

/**
 * Compute the `data-chat-flow-key` corresponding to a top-level {@link RenderEntry}.
 * Matches the key written by `ChatNodeSeat` and `ChatGroupSeat`.
 */
export function entryFlowKey(entry: RenderEntry): string {
  if (entry.kind === "group") return entry.key;
  return entry.groupPart === undefined || entry.groupPart === "response"
    ? entry.key
    : JSON.stringify([entry.key, entry.groupPart]);
}

/**
 * Resolve `ResponseAnnotationAnchor.answerKey` (`JSON.stringify([nodeKey, groupPart ?? null])`)
 * to its top-level `data-chat-flow-key`.
 */
export function flowKeyForAnswerKey(answerKey: string): string | null {
  try {
    const parsed: unknown = JSON.parse(answerKey);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return null;
    const [nodeKey, groupPart] = parsed;
    return groupPart === null || groupPart === undefined || groupPart === "response"
      ? nodeKey
      : JSON.stringify([nodeKey, String(groupPart)]);
  } catch {
    return null;
  }
}

/** Strip the `group:` prefix from a `ChatScrollPosition.anchorKey` to obtain its flow key. */
export function flowKeyForScrollAnchor(anchorKey: string): string {
  return anchorKey.startsWith("group:") ? anchorKey.slice("group:".length) : anchorKey;
}

/** Detect native browser find shortcuts (`Cmd+F` / `Ctrl+F`) without blocking them. */
export function isFindShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "key">,
): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f";
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const element = target as Partial<HTMLElement>;
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.getAttribute === "function") {
    const contentEditable = element.getAttribute("contenteditable");
    if (contentEditable === "" || contentEditable === "true") return true;
  }
  if (typeof element.closest === "function") {
    if (element.closest("[contenteditable=''], [contenteditable='true']") !== null) return true;
  }
  return false;
}

function isFindRenewalKey(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "key" | "target">,
): boolean {
  if (isFindShortcut(event)) return true;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g") {
    return true;
  }
  if (event.key === "F3") return true;
  if (event.key === "Enter" && !isEditableEventTarget(event.target)) return true;
  return false;
}

function turnOfNode(node: ReturnType<ChatSnapshot["nodes"]["get"]>): number | undefined {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : undefined;
}

function isEmptyRowShell(element: HTMLElement): boolean {
  if (element.childNodes.length === 0) return true;
  if (element.childElementCount === 1) {
    const child = element.firstElementChild;
    if (child?.hasAttribute("data-slot") && child.childNodes.length === 0) return true;
  }
  return false;
}

function readElementHeight(element: HTMLElement): number {
  const rectHeight = element.getBoundingClientRect().height;
  if (rectHeight > 0) return rectHeight;
  return element.offsetHeight;
}

function recordMeasuredHeight(
  heights: Map<string, number>,
  flowKey: string,
  element: HTMLElement,
  measuredHeight?: number,
): void {
  if (element.hasAttribute("hidden") || element.hasAttribute("data-chat-virtualized")) return;
  const height =
    measuredHeight !== undefined && measuredHeight > 0
      ? measuredHeight
      : readElementHeight(element);
  if (height > 0) {
    heights.set(flowKey, Math.round(height));
  } else if (isEmptyRowShell(element)) {
    heights.set(flowKey, 0);
  }
}

/** Walk up from `node` to the direct child of `column` and read its top-level `data-chat-flow-key`. */
export function findTopLevelRowFlowKey(node: Node | null, column: HTMLElement): string | null {
  if (node === null) return null;
  let current: Element | null = node instanceof Element ? node : node.parentElement;
  if (current === null || !column.contains(current)) return null;
  while (current !== null && current.parentElement !== column) {
    current = current.parentElement;
  }
  if (current === null || current.parentElement !== column) return null;
  return current.getAttribute("data-chat-flow-key");
}

function endpointRowIndex(
  container: Node,
  offset: number,
  boundary: "start" | "end",
  column: HTMLElement,
  flowKeyToIndex: ReadonlyMap<string, number>,
  entryCount: number,
): number | null {
  if (entryCount === 0) return null;
  if (container === column) {
    const childCount = column.childNodes.length;
    if (childCount === 0) return null;
    const rawIdx = boundary === "end" ? Math.max(0, offset - 1) : Math.min(offset, childCount - 1);
    const step = boundary === "end" ? -1 : 1;
    for (let i = rawIdx; i >= 0 && i < childCount; i += step) {
      const child = column.childNodes[i];
      if (child instanceof Element) {
        const key = child.getAttribute("data-chat-flow-key");
        if (key !== null) {
          const idx = flowKeyToIndex.get(key);
          if (idx !== undefined) return idx;
        }
      }
    }
    return null;
  }
  const directKey = findTopLevelRowFlowKey(container, column);
  if (directKey !== null) {
    return flowKeyToIndex.get(directKey) ?? null;
  }
  const position = column.compareDocumentPosition(container);
  if ((position & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 0;
  if ((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return entryCount - 1;
  return null;
}

/**
 * Resolve the inclusive top-level entry span covered by the current DOM selection.
 * Returns `null` when there is no non-collapsed selection overlapping `column`.
 */
export function resolveSelectionFlowRange(
  selection: Selection | null,
  column: HTMLElement,
  flowKeys: readonly string[],
  flowKeyToIndex: ReadonlyMap<string, number>,
): SelectionFlowRange | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (flowKeys.length === 0) return null;

  let minIndex = Number.POSITIVE_INFINITY;
  let maxIndex = -1;

  for (let r = 0; r < selection.rangeCount; r += 1) {
    const range = selection.getRangeAt(r);
    if (range.collapsed) continue;
    const startInside = column.contains(range.startContainer);
    const endInside = column.contains(range.endContainer);
    const startBefore =
      !startInside &&
      (column.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_PRECEDING) !==
        0;
    const endAfter =
      !endInside &&
      (column.compareDocumentPosition(range.endContainer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    if (!startInside && !endInside && !(startBefore && endAfter)) continue;

    const startIdx = endpointRowIndex(
      range.startContainer,
      range.startOffset,
      "start",
      column,
      flowKeyToIndex,
      flowKeys.length,
    );
    const endIdx = endpointRowIndex(
      range.endContainer,
      range.endOffset,
      "end",
      column,
      flowKeyToIndex,
      flowKeys.length,
    );
    if (startIdx === null && endIdx === null) continue;
    const lo = startIdx ?? endIdx ?? 0;
    const hi = endIdx ?? startIdx ?? flowKeys.length - 1;
    minIndex = Math.min(minIndex, lo, hi);
    maxIndex = Math.max(maxIndex, lo, hi);
  }

  if (maxIndex < 0 || !Number.isFinite(minIndex)) return null;
  const startKey = flowKeys[minIndex];
  const endKey = flowKeys[maxIndex];
  if (startKey === undefined || endKey === undefined) return null;
  return { startKey, endKey };
}

function sameSelectionRange(
  left: SelectionFlowRange | null,
  right: SelectionFlowRange | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.startKey === right.startKey && left.endKey === right.endKey;
}

function sameNavigationTarget(
  left: NavigationPinTarget | null,
  right: NavigationPinTarget | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.turn === right.turn && left.anchorKey === right.anchorKey;
}

/**
 * Virtualize offscreen top-level transcript row contents while keeping outer row
 * shells, heights, selection spans, focus/editing, jump targets, tail streaming,
 * and native `Cmd+F` / `Ctrl+F` search intact.
 */
export function useTranscriptVirtualization({
  sessionId,
  entries,
  nodeStore,
  listRef,
  columnRef,
  editingFlowKey = null,
  revealTargetFlowKey = null,
  savedAnchorFlowKey = null,
  busyTurn = null,
  findLeaseTimeoutMs = FIND_LEASE_TIMEOUT_MS,
  overscanMargin = VIRTUALIZE_OVERSCAN_MARGIN,
}: TranscriptVirtualizationInput): TranscriptVirtualization {
  const hasIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const enabled = entries.length > VIRTUALIZE_THRESHOLD && hasIntersectionObserver;

  const sessionRef = useRef(sessionId);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const visibleKeysRef = useRef<Set<string>>(new Set());
  const mountedKeysRef = useRef<Set<string>>(new Set());
  const ioRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeObservedRef = useRef<Set<HTMLDivElement>>(new Set());
  const findLeaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId;
    heightsRef.current.clear();
    visibleKeysRef.current = new Set();
    mountedKeysRef.current = new Set();
  }

  const [visibleState, setVisibleState] = useState<{
    readonly sessionId: string;
    readonly keys: ReadonlySet<string>;
  }>(() => ({ sessionId, keys: new Set() }));
  const [selectionState, setSelectionState] = useState<{
    readonly sessionId: string;
    readonly range: SelectionFlowRange | null;
  }>(() => ({ sessionId, range: null }));
  const [focusedState, setFocusedState] = useState<{
    readonly sessionId: string;
    readonly flowKey: string | null;
  }>(() => ({ sessionId, flowKey: null }));
  const [navigationState, setNavigationState] = useState<{
    readonly sessionId: string;
    readonly target: NavigationPinTarget | null;
  }>(() => ({ sessionId, target: null }));
  const [findLeaseState, setFindLeaseState] = useState<{
    readonly sessionId: string;
    readonly active: boolean;
  }>(() => ({ sessionId, active: false }));

  const visibleKeys =
    visibleState.sessionId === sessionId ? visibleState.keys : visibleKeysRef.current;
  const selectionRange = selectionState.sessionId === sessionId ? selectionState.range : null;
  const focusedFlowKey = focusedState.sessionId === sessionId ? focusedState.flowKey : null;
  const navigationPin = navigationState.sessionId === sessionId ? navigationState.target : null;
  const findLeaseActive =
    enabled && findLeaseState.sessionId === sessionId && findLeaseState.active;

  const { flowKeys, flowKeyToIndex } = useMemo(() => {
    const keys: string[] = new Array(entries.length);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < entries.length; i += 1) {
      const key = entryFlowKey(entries[i]!);
      keys[i] = key;
      indexMap.set(key, i);
    }
    return { flowKeys: keys, flowKeyToIndex: indexMap };
  }, [entries]);

  const flowKeysRef = useRef(flowKeys);
  const flowKeyToIndexRef = useRef(flowKeyToIndex);
  flowKeysRef.current = flowKeys;
  flowKeyToIndexRef.current = flowKeyToIndex;

  const measureMountedRows = useCallback(() => {
    const heights = heightsRef.current;
    const elements = rowElementsRef.current;
    for (const flowKey of mountedKeysRef.current) {
      const el = elements.get(flowKey);
      if (el !== undefined) recordMeasuredHeight(heights, flowKey, el);
    }
  }, []);

  const clearFindLeaseTimer = useCallback(() => {
    if (findLeaseTimerRef.current !== null) {
      clearTimeout(findLeaseTimerRef.current);
      findLeaseTimerRef.current = null;
    }
  }, []);

  const releaseFindLease = useCallback(() => {
    clearFindLeaseTimer();
    measureMountedRows();
    setFindLeaseState((prev) =>
      prev.sessionId === sessionId && !prev.active ? prev : { sessionId, active: false },
    );
  }, [clearFindLeaseTimer, measureMountedRows, sessionId]);

  const activateOrRenewFindLease = useCallback(() => {
    clearFindLeaseTimer();
    setFindLeaseState((prev) =>
      prev.sessionId === sessionId && prev.active ? prev : { sessionId, active: true },
    );
    findLeaseTimerRef.current = setTimeout(() => {
      findLeaseTimerRef.current = null;
      measureMountedRows();
      setFindLeaseState((prev) =>
        prev.sessionId === sessionId && !prev.active ? prev : { sessionId, active: false },
      );
    }, findLeaseTimeoutMs);
  }, [clearFindLeaseTimer, findLeaseTimeoutMs, measureMountedRows, sessionId]);

  // Reset lease timer whenever session changes or virtualization deactivates.
  useEffect(() => {
    if (!enabled) {
      clearFindLeaseTimer();
      return;
    }
    return () => {
      clearFindLeaseTimer();
    };
  }, [clearFindLeaseTimer, enabled, sessionId]);

  // Shared IntersectionObserver tracking top-level row shells within overscan of the scrollport.
  useLayoutEffect(() => {
    if (!enabled) {
      ioRef.current = null;
      return;
    }
    const list = listRef.current;
    const root = list?.closest("[data-conversation-scroll]") ?? list ?? null;
    const observer = new IntersectionObserver(
      (ioEntries) => {
        let changed = false;
        const next = new Set(visibleKeysRef.current);
        for (const ioEntry of ioEntries) {
          const target = ioEntry.target;
          if (!(target instanceof HTMLElement)) continue;
          const flowKey = target.dataset.chatFlowKey;
          if (flowKey === undefined) continue;
          if (ioEntry.isIntersecting) {
            if (!next.has(flowKey)) {
              next.add(flowKey);
              changed = true;
            }
          } else {
            if (mountedKeysRef.current.has(flowKey)) {
              const measured = ioEntry.boundingClientRect?.height;
              recordMeasuredHeight(heightsRef.current, flowKey, target, measured);
            }
            if (next.has(flowKey)) {
              next.delete(flowKey);
              changed = true;
            }
          }
        }
        if (changed) {
          visibleKeysRef.current = next;
          setVisibleState({ sessionId, keys: next });
        }
      },
      { root, rootMargin: overscanMargin },
    );
    ioRef.current = observer;
    for (const element of rowElementsRef.current.values()) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      if (ioRef.current === observer) ioRef.current = null;
    };
  }, [enabled, listRef, overscanMargin, sessionId]);

  // Track selection spans across top-level rows via document `selectionchange`.
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const syncSelection = (): void => {
      const column = columnRef.current;
      const next =
        column === null
          ? null
          : resolveSelectionFlowRange(
              document.getSelection(),
              column,
              flowKeysRef.current,
              flowKeyToIndexRef.current,
            );
      setSelectionState((prev) => {
        const current = prev.sessionId === sessionId ? prev.range : null;
        if (sameSelectionRange(current, next)) return prev;
        if (current !== null) measureMountedRows();
        return { sessionId, range: next };
      });
    };
    syncSelection();
    document.addEventListener("selectionchange", syncSelection);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
    };
  }, [columnRef, enabled, measureMountedRows, sessionId]);

  // Keep the row containing `document.activeElement` mounted.
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const column = columnRef.current;
    if (column === null) return;

    const updateFocus = (flowKey: string | null): void => {
      setFocusedState((prev) => {
        const current = prev.sessionId === sessionId ? prev.flowKey : null;
        if (current === flowKey) return prev;
        if (current !== null) measureMountedRows();
        return { sessionId, flowKey };
      });
    };

    const syncFromActiveElement = (): void => {
      updateFocus(findTopLevelRowFlowKey(document.activeElement, column));
    };

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target instanceof Node ? event.target : document.activeElement;
      updateFocus(findTopLevelRowFlowKey(target, column));
    };

    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node) {
        updateFocus(findTopLevelRowFlowKey(event.relatedTarget, column));
        return;
      }
      queueMicrotask(() => {
        if (!column.isConnected) return;
        syncFromActiveElement();
      });
    };

    syncFromActiveElement();
    column.addEventListener("focusin", onFocusIn);
    column.addEventListener("focusout", onFocusOut);
    return () => {
      column.removeEventListener("focusin", onFocusIn);
      column.removeEventListener("focusout", onFocusOut);
    };
  }, [columnRef, enabled, measureMountedRows, sessionId]);

  // Global Cmd+F / Ctrl+F listener activating temporary full-mount lease without blocking native find.
  const findLeaseActiveRef = useRef(findLeaseActive);
  findLeaseActiveRef.current = findLeaseActive;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isFindShortcut(event)) {
        activateOrRenewFindLease();
        return;
      }
      if (!findLeaseActiveRef.current) return;
      if (event.key === "Escape") {
        releaseFindLease();
      } else if (isFindRenewalKey(event)) {
        activateOrRenewFindLease();
      }
    };
    const onBeforeMatch = (): void => {
      if (findLeaseActiveRef.current) activateOrRenewFindLease();
    };
    const onEditableFocusIn = (event: FocusEvent): void => {
      if (findLeaseActiveRef.current && isEditableEventTarget(event.target)) {
        releaseFindLease();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("beforematch", onBeforeMatch, true);
    document.addEventListener("focusin", onEditableFocusIn, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("beforematch", onBeforeMatch, true);
      document.removeEventListener("focusin", onEditableFocusIn, true);
    };
  }, [activateOrRenewFindLease, enabled, releaseFindLease]);

  // Compute pinned indices/keys for the current render.
  const pinnedKeys = useMemo(() => {
    const pinned = new Set<string>();
    const pinIndexWindow = (index: number, following: number): void => {
      const end = Math.min(entries.length - 1, index + following);
      for (let i = index; i <= end; i += 1) {
        const key = flowKeys[i];
        if (key !== undefined) pinned.add(key);
      }
    };
    const pinAnchorKey = (anchorKey: string | null | undefined, following = 0): void => {
      if (anchorKey === null || anchorKey === undefined || anchorKey === "") return;
      const normalized = flowKeyForScrollAnchor(anchorKey);
      const directIdx = flowKeyToIndex.get(normalized);
      if (directIdx !== undefined) {
        pinIndexWindow(directIdx, following);
        return;
      }
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.kind === "node" && entry.key === normalized) {
          pinIndexWindow(i, following);
          return;
        }
      }
    };
    const pinTurn = (turn: number | null | undefined): void => {
      if (turn === null || turn === undefined) return;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.kind === "node" && turnOfNode(nodeStore.get(entry.key)) === turn) {
          pinIndexWindow(i, JUMP_TARGET_FOLLOWING_ROWS);
          return;
        }
      }
    };

    if (editingFlowKey !== null) pinned.add(editingFlowKey);
    if (focusedFlowKey !== null) pinned.add(focusedFlowKey);
    if (revealTargetFlowKey !== null) pinAnchorKey(revealTargetFlowKey, 0);
    if (savedAnchorFlowKey !== null) pinAnchorKey(savedAnchorFlowKey, JUMP_TARGET_FOLLOWING_ROWS);
    if (busyTurn !== null) pinTurn(busyTurn);
    if (navigationPin !== null) {
      if (navigationPin.anchorKey !== null) {
        pinAnchorKey(navigationPin.anchorKey, JUMP_TARGET_FOLLOWING_ROWS);
      } else if (navigationPin.turn !== null) {
        pinTurn(navigationPin.turn);
      }
    }
    return pinned;
  }, [
    busyTurn,
    editingFlowKey,
    entries,
    flowKeyToIndex,
    flowKeys,
    focusedFlowKey,
    navigationPin,
    nodeStore,
    revealTargetFlowKey,
    savedAnchorFlowKey,
  ]);

  const selectionBounds = useMemo(() => {
    if (selectionRange === null) return null;
    const start = flowKeyToIndex.get(selectionRange.startKey);
    const end = flowKeyToIndex.get(selectionRange.endKey);
    if (start === undefined || end === undefined) return null;
    return start <= end ? { start, end } : { start: end, end: start };
  }, [flowKeyToIndex, selectionRange]);

  const virtualizing = enabled && !findLeaseActive;
  const tailStartIndex = Math.max(0, entries.length - PIN_TAIL);

  const isMounted = useCallback(
    (index: number, flowKey: string): boolean => {
      if (!virtualizing) return true;
      if (index >= tailStartIndex) return true;
      if (visibleKeys.has(flowKey)) return true;
      if (pinnedKeys.has(flowKey)) return true;
      if (
        selectionBounds !== null &&
        index >= selectionBounds.start &&
        index <= selectionBounds.end
      )
        return true;
      return false;
    },
    [pinnedKeys, selectionBounds, tailStartIndex, virtualizing, visibleKeys],
  );

  // Maintain the set of currently mounted flow keys and observe only mounted rows with ResizeObserver.
  const currentMountedKeys = useMemo(() => {
    if (!enabled) return new Set<string>();
    const set = new Set<string>();
    for (let i = 0; i < entries.length; i += 1) {
      const key = flowKeys[i]!;
      if (isMounted(i, key)) set.add(key);
    }
    return set;
  }, [enabled, entries.length, flowKeys, isMounted]);

  useLayoutEffect(() => {
    mountedKeysRef.current = currentMountedKeys;
    if (!enabled) {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      resizeObservedRef.current.clear();
      return;
    }
    if (typeof ResizeObserver !== "undefined" && resizeObserverRef.current === null) {
      resizeObserverRef.current = new ResizeObserver((roEntries) => {
        for (const roEntry of roEntries) {
          const target = roEntry.target;
          if (!(target instanceof HTMLElement)) continue;
          const flowKey = target.dataset.chatFlowKey;
          if (flowKey === undefined || !mountedKeysRef.current.has(flowKey)) continue;
          const boxHeight = roEntry.borderBoxSize?.[0]?.blockSize ?? roEntry.contentRect.height;
          recordMeasuredHeight(heightsRef.current, flowKey, target, boxHeight);
        }
      });
    }
    const ro = resizeObserverRef.current;
    const observed = resizeObservedRef.current;
    const elements = rowElementsRef.current;

    for (const el of Array.from(observed)) {
      const flowKey = el.dataset.chatFlowKey;
      if (
        flowKey === undefined ||
        !currentMountedKeys.has(flowKey) ||
        elements.get(flowKey) !== el
      ) {
        ro?.unobserve(el);
        observed.delete(el);
      }
    }
    for (const flowKey of currentMountedKeys) {
      const el = elements.get(flowKey);
      if (el === undefined) continue;
      recordMeasuredHeight(heightsRef.current, flowKey, el);
      if (ro !== null && !observed.has(el)) {
        ro.observe(el);
        observed.add(el);
      }
    }
  }, [currentMountedKeys, enabled]);

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      resizeObservedRef.current.clear();
    };
  }, []);

  const registerRow = useCallback((flowKey: string, element: HTMLDivElement | null) => {
    const map = rowElementsRef.current;
    const previous = map.get(flowKey);
    if (previous !== undefined && previous !== element) {
      ioRef.current?.unobserve(previous);
      resizeObserverRef.current?.unobserve(previous);
      resizeObservedRef.current.delete(previous);
    }
    if (element === null) {
      map.delete(flowKey);
      return;
    }
    map.set(flowKey, element);
    ioRef.current?.observe(element);
    if (mountedKeysRef.current.has(flowKey)) {
      recordMeasuredHeight(heightsRef.current, flowKey, element);
      if (resizeObserverRef.current !== null && !resizeObservedRef.current.has(element)) {
        resizeObserverRef.current.observe(element);
        resizeObservedRef.current.add(element);
      }
    }
  }, []);

  const placeholderHeight = useCallback((flowKey: string, kind: RenderEntry["kind"]): number => {
    const cached = heightsRef.current.get(flowKey);
    if (cached !== undefined) return cached;
    // Fallback: if this row was mounted on the previous render of the same session
    // and is unmounting before ResizeObserver reported, sample its live shell before commit.
    const liveEl = mountedKeysRef.current.has(flowKey)
      ? rowElementsRef.current.get(flowKey)
      : undefined;
    if (
      liveEl !== undefined &&
      !liveEl.hasAttribute("hidden") &&
      !liveEl.hasAttribute("data-chat-virtualized")
    ) {
      const liveHeight = readElementHeight(liveEl);
      if (liveHeight > 0) {
        const rounded = Math.round(liveHeight);
        heightsRef.current.set(flowKey, rounded);
        return rounded;
      }
      if (isEmptyRowShell(liveEl)) {
        heightsRef.current.set(flowKey, 0);
        return 0;
      }
    }
    return kind === "group" ? ESTIMATED_GROUP_HEIGHT : ESTIMATED_NODE_HEIGHT;
  }, []);

  const isAnchorMounted = useCallback(
    (anchorKey: string): boolean => {
      if (!virtualizing) return true;
      const normalized = flowKeyForScrollAnchor(anchorKey);
      const directIdx = flowKeyToIndex.get(normalized);
      if (directIdx !== undefined) return isMounted(directIdx, normalized);
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]!;
        if (entry.kind === "node" && entry.key === normalized) {
          return isMounted(i, flowKeys[i]!);
        }
      }
      return false;
    },
    [entries, flowKeyToIndex, flowKeys, isMounted, virtualizing],
  );

  const pinNavigationTarget = useCallback(
    (target: NavigationPinTarget | null) => {
      setNavigationState((prev) => {
        const current = prev.sessionId === sessionId ? prev.target : null;
        if (sameNavigationTarget(current, target)) return prev;
        if (current !== null) measureMountedRows();
        return { sessionId, target };
      });
    },
    [measureMountedRows, sessionId],
  );

  const clearNavigationPin = useCallback(() => {
    pinNavigationTarget(null);
  }, [pinNavigationTarget]);

  return useMemo<TranscriptVirtualization>(
    () => ({
      active: enabled,
      findLeaseActive,
      isMounted,
      isAnchorMounted,
      placeholderHeight,
      registerRow,
      pinNavigationTarget,
      clearNavigationPin,
    }),
    [
      clearNavigationPin,
      enabled,
      findLeaseActive,
      isAnchorMounted,
      isMounted,
      pinNavigationTarget,
      placeholderHeight,
      registerRow,
    ],
  );
}
