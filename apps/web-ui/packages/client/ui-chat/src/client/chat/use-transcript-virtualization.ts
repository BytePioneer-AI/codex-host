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
import type {
  GroupKey,
  NodeReference,
  RenderEntry,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ChatSnapshot } from "../contract/snapshot.ts";

/** Minimum top-level entry count required before content virtualization activates. */
export const VIRTUALIZE_THRESHOLD = 48;
/** Number of newest top-level entries permanently pinned at the transcript tail. */
export const PIN_TAIL = 10;
/** Idle timeout before releasing a temporary native-find full-mount lease. */
export const FIND_LEASE_TIMEOUT_MS = 30_000;
/** Hard duration ceiling for a temporary native-find full-mount lease. */
export const FIND_LEASE_MAX_DURATION_MS = 180_000;
const OVERSCAN_MULTIPLIER = 1.5;
const OVERSCAN_BUCKET_PX = 160;
const MIN_OVERSCAN_PX = 320;
const FALLBACK_OVERSCAN_PX = 1200;
const FOLLOW_BOTTOM_THRESHOLD_PX = 24;
/** Fallback pixel IntersectionObserver rootMargin (~1.5 viewport heights at 800px). */
export const VIRTUALIZE_OVERSCAN_MARGIN = `${FALLBACK_OVERSCAN_PX}px 0px`;
/** Conservative placeholder height (px) for unmeasured node rows. */
export const ESTIMATED_NODE_HEIGHT = 80;
/** Conservative placeholder height (px) for unmeasured group rows. */
export const ESTIMATED_GROUP_HEIGHT = 32;
/** Extra following rows mounted alongside a jump target so the landing viewport renders immediately. */
const JUMP_TARGET_FOLLOWING_ROWS = 2;
const EMPTY_MOUNTED_KEYS: ReadonlySet<string> = new Set();

/**
 * Compute a bucketed pixel vertical `rootMargin` (~1.5x root viewport height)
 * so IntersectionObserver never resolves `%` against the scrollport's width.
 */
export function computeOverscanMargin(rootHeight: number): string {
  if (!Number.isFinite(rootHeight) || rootHeight <= 0) {
    return VIRTUALIZE_OVERSCAN_MARGIN;
  }
  const bucketed = Math.max(
    MIN_OVERSCAN_PX,
    Math.ceil((rootHeight * OVERSCAN_MULTIPLIER) / OVERSCAN_BUCKET_PX) * OVERSCAN_BUCKET_PX,
  );
  return `${bucketed}px 0px`;
}

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
  /** Override maximum hard duration for the native-find lease (defaults to {@link FIND_LEASE_MAX_DURATION_MS}). */
  readonly findLeaseMaxDurationMs?: number;
  /** Override IntersectionObserver rootMargin (defaults to 1.5x `root.clientHeight` in px). */
  readonly overscanMargin?: string;
  /** Invoked synchronously after commit when virtualization while tail-following clamps `scrollTop`. */
  readonly onTailScrollClamp?: () => void;
  /** Invoked after synchronous reading-mode scroll compensation adjusts `scroller.scrollTop`. */
  readonly onScrollCompensated?: (delta: number) => void;
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

/** Minimal grouped-view lookup needed to map grouped members to their top-level group key. */
export interface GroupedChatLookup {
  groupSource(key: GroupKey): {
    getSnapshot(): { readonly members: readonly NodeReference[] } | undefined;
  };
}

/**
 * Resolve a response annotation `answerKey` to the top-level flow key that must
 * stay mounted, mapping grouped inner members to their enclosing `groupKey`.
 */
export function resolveRevealTargetFlowKey(
  answerKey: string,
  entries: readonly RenderEntry[],
  groupedView: GroupedChatLookup | undefined,
): string | null {
  const rawFlowKey = flowKeyForAnswerKey(answerKey);
  if (rawFlowKey === null) return null;
  for (const entry of entries) {
    if (entryFlowKey(entry) === rawFlowKey) return rawFlowKey;
    if (entry.kind === "node" && entry.key === rawFlowKey) return entryFlowKey(entry);
  }
  if (groupedView !== undefined) {
    for (const entry of entries) {
      if (entry.kind !== "group") continue;
      const members = groupedView.groupSource(entry.key).getSnapshot()?.members;
      if (members === undefined) continue;
      if (
        members.some((member) => entryFlowKey(member) === rawFlowKey || member.key === rawFlowKey)
      ) {
        return entry.key;
      }
    }
  }
  return rawFlowKey;
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

function normalizeMeasuredHeight(height: number): number {
  return Math.round(height * 100) / 100;
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
    heights.set(flowKey, normalizeMeasuredHeight(height));
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

function scanColumnChildRowIndex(
  column: HTMLElement,
  startChildIndex: number,
  step: 1 | -1,
  flowKeyToIndex: ReadonlyMap<string, number>,
): number | null {
  const childCount = column.childNodes.length;
  for (let i = startChildIndex; i >= 0 && i < childCount; i += step) {
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

function insideColumnEndpointIndex(
  container: Node,
  offset: number,
  boundary: "start" | "end",
  column: HTMLElement,
  flowKeyToIndex: ReadonlyMap<string, number>,
): number | null {
  const childCount = column.childNodes.length;
  if (childCount === 0) return null;
  const step: 1 | -1 = boundary === "end" ? -1 : 1;
  if (container === column) {
    if (boundary === "end" && offset <= 0) return null;
    if (boundary === "start" && offset >= childCount) return null;
    const rawIdx = boundary === "end" ? Math.min(offset - 1, childCount - 1) : Math.max(0, offset);
    return scanColumnChildRowIndex(column, rawIdx, step, flowKeyToIndex);
  }
  let directChild: Node | null = container;
  while (directChild !== null && directChild.parentNode !== column) {
    directChild = directChild.parentNode;
  }
  if (directChild === null || directChild.parentNode !== column) return null;
  if (directChild instanceof Element) {
    const key = directChild.getAttribute("data-chat-flow-key");
    if (key !== null) {
      return flowKeyToIndex.get(key) ?? null;
    }
  }
  for (let i = 0; i < childCount; i += 1) {
    if (column.childNodes[i] === directChild) {
      return scanColumnChildRowIndex(column, i + step, step, flowKeyToIndex);
    }
  }
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

  const ownerDocument = column.ownerDocument;
  const columnRange = ownerDocument.createRange();
  if (column.parentNode !== null) {
    columnRange.selectNode(column);
  } else {
    columnRange.selectNodeContents(column);
  }

  let minIndex = Number.POSITIVE_INFINITY;
  let maxIndex = -1;

  for (let r = 0; r < selection.rangeCount; r += 1) {
    const range = selection.getRangeAt(r);
    if (range.collapsed) continue;
    let startsBeforeColumnEnd: boolean;
    let endsAfterColumnStart: boolean;
    try {
      // END_TO_START compares range.start vs columnRange.end;
      // START_TO_END compares range.end vs columnRange.start.
      startsBeforeColumnEnd = range.compareBoundaryPoints(range.END_TO_START, columnRange) < 0;
      endsAfterColumnStart = range.compareBoundaryPoints(range.START_TO_END, columnRange) > 0;
    } catch {
      continue;
    }
    if (!startsBeforeColumnEnd || !endsAfterColumnStart) continue;

    const startInside = column.contains(range.startContainer);
    const endInside = column.contains(range.endContainer);

    let startIdx: number | null;
    if (startInside) {
      startIdx = insideColumnEndpointIndex(
        range.startContainer,
        range.startOffset,
        "start",
        column,
        flowKeyToIndex,
      );
    } else {
      startIdx = range.compareBoundaryPoints(range.START_TO_START, columnRange) <= 0 ? 0 : null;
    }

    let endIdx: number | null;
    if (endInside) {
      endIdx = insideColumnEndpointIndex(
        range.endContainer,
        range.endOffset,
        "end",
        column,
        flowKeyToIndex,
      );
    } else {
      endIdx =
        range.compareBoundaryPoints(range.END_TO_END, columnRange) >= 0
          ? flowKeys.length - 1
          : null;
    }

    if (startIdx === null || endIdx === null || startIdx > endIdx) continue;
    minIndex = Math.min(minIndex, startIdx);
    maxIndex = Math.max(maxIndex, endIdx);
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

interface PendingScrollCompensation {
  readonly scroller: HTMLElement;
  readonly anchorEl: HTMLElement;
  readonly prevTop: number;
  readonly prevScrollTop: number;
  readonly scrollVersion: number;
}

function mountedSetChanged(prev: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  if (prev.size !== next.size) return true;
  for (const key of prev) {
    if (!next.has(key)) return true;
  }
  return false;
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
  findLeaseMaxDurationMs = FIND_LEASE_MAX_DURATION_MS,
  overscanMargin,
  onTailScrollClamp,
  onScrollCompensated,
}: TranscriptVirtualizationInput): TranscriptVirtualization {
  const hasIntersectionObserver = typeof IntersectionObserver !== "undefined";
  const enabled = entries.length > VIRTUALIZE_THRESHOLD && hasIntersectionObserver;

  const sessionRef = useRef(sessionId);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const rowElementsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const visibleKeysRef = useRef<Set<string>>(new Set());
  const mountedKeysRef = useRef<ReadonlySet<string>>(EMPTY_MOUNTED_KEYS);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const ioSettledRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeObservedRef = useRef<Set<HTMLDivElement>>(new Set());
  const findLeaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const findLeaseStartedAtRef = useRef<number | null>(null);
  const pendingScrollCompensationRef = useRef<PendingScrollCompensation | null>(null);
  const pendingTailRestoreRef = useRef<HTMLElement | null>(null);
  const scrollVersionRef = useRef(0);
  const onTailScrollClampRef = useRef(onTailScrollClamp);
  onTailScrollClampRef.current = onTailScrollClamp;
  const onScrollCompensatedRef = useRef(onScrollCompensated);
  onScrollCompensatedRef.current = onScrollCompensated;

  if (sessionRef.current !== sessionId) {
    sessionRef.current = sessionId;
    heightsRef.current.clear();
    visibleKeysRef.current = new Set();
    mountedKeysRef.current = EMPTY_MOUNTED_KEYS;
    ioSettledRef.current = false;
    findLeaseStartedAtRef.current = null;
    pendingScrollCompensationRef.current = null;
    pendingTailRestoreRef.current = null;
  }

  const [visibleState, setVisibleState] = useState<{
    readonly sessionId: string;
    readonly keys: ReadonlySet<string>;
  }>(() => ({ sessionId, keys: new Set() }));
  const [ioSettledState, setIoSettledState] = useState<{
    readonly sessionId: string;
    readonly settled: boolean;
  }>(() => ({ sessionId, settled: false }));
  const [measuredOverscanMargin, setMeasuredOverscanMargin] = useState<string>(
    VIRTUALIZE_OVERSCAN_MARGIN,
  );
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
  const ioSettled = enabled && ioSettledState.sessionId === sessionId && ioSettledState.settled;
  const effectiveOverscanMargin = overscanMargin ?? measuredOverscanMargin;
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
    findLeaseStartedAtRef.current = null;
    measureMountedRows();
    setFindLeaseState((prev) =>
      prev.sessionId === sessionId && !prev.active ? prev : { sessionId, active: false },
    );
  }, [clearFindLeaseTimer, measureMountedRows, sessionId]);

  const scheduleFindLeaseTimer = useCallback(
    (delayMs: number) => {
      clearFindLeaseTimer();
      findLeaseTimerRef.current = setTimeout(() => {
        findLeaseTimerRef.current = null;
        findLeaseStartedAtRef.current = null;
        measureMountedRows();
        setFindLeaseState((prev) =>
          prev.sessionId === sessionId && !prev.active ? prev : { sessionId, active: false },
        );
      }, delayMs);
    },
    [clearFindLeaseTimer, measureMountedRows, sessionId],
  );

  const activateFindLease = useCallback(() => {
    findLeaseStartedAtRef.current = Date.now();
    setFindLeaseState((prev) =>
      prev.sessionId === sessionId && prev.active ? prev : { sessionId, active: true },
    );
    scheduleFindLeaseTimer(Math.min(findLeaseTimeoutMs, findLeaseMaxDurationMs));
  }, [findLeaseMaxDurationMs, findLeaseTimeoutMs, scheduleFindLeaseTimer, sessionId]);

  const renewFindLease = useCallback(() => {
    const startedAt = findLeaseStartedAtRef.current ?? Date.now();
    findLeaseStartedAtRef.current = startedAt;
    const remainingCap = findLeaseMaxDurationMs - (Date.now() - startedAt);
    if (remainingCap <= 0) {
      releaseFindLease();
      return;
    }
    scheduleFindLeaseTimer(Math.min(findLeaseTimeoutMs, remainingCap));
  }, [findLeaseMaxDurationMs, findLeaseTimeoutMs, releaseFindLease, scheduleFindLeaseTimer]);

  // Reset lease state and IO settle gate whenever session changes or virtualization deactivates.
  useEffect(() => {
    if (!enabled) {
      clearFindLeaseTimer();
      findLeaseStartedAtRef.current = null;
      ioSettledRef.current = false;
      setFindLeaseState((prev) =>
        prev.sessionId === sessionId && !prev.active ? prev : { sessionId, active: false },
      );
      setIoSettledState((prev) =>
        prev.sessionId === sessionId && !prev.settled ? prev : { sessionId, settled: false },
      );
      return;
    }
    return () => {
      clearFindLeaseTimer();
    };
  }, [clearFindLeaseTimer, enabled, sessionId]);

  // Derive default pixel overscan from the scrollport's height and track container resizes.
  useLayoutEffect(() => {
    if (!enabled || overscanMargin !== undefined) return;
    const list = listRef.current;
    const root = list?.closest("[data-conversation-scroll]") ?? list ?? null;
    if (root === null) return;
    const update = (height: number): void => {
      const next = computeOverscanMargin(height);
      setMeasuredOverscanMargin((prev) => (prev === next ? prev : next));
    };
    update(root.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((roEntries) => {
      const entry = roEntries.at(-1);
      const height = entry?.contentRect.height ?? root.clientHeight;
      update(height > 0 ? height : root.clientHeight);
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
    };
  }, [enabled, listRef, overscanMargin, sessionId]);

  // Track scroll events on the active scrollport so pre-commit compensation skips
  // commits interrupted by an asynchronous scroll event while still recovering from
  // synchronous engine layout clamps during React DOM commits.
  useLayoutEffect(() => {
    if (!enabled) return;
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>("[data-conversation-scroll]") ?? list ?? null;
    if (scroller === null) return;
    const onScroll = (): void => {
      scrollVersionRef.current += 1;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [enabled, listRef, sessionId]);

  // Shared IntersectionObserver tracking top-level row shells within overscan of the scrollport.
  useLayoutEffect(() => {
    if (!enabled) {
      ioRef.current = null;
      ioSettledRef.current = false;
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
            if (mountedKeysRef.current.has(flowKey) && !heightsRef.current.has(flowKey)) {
              const measured = ioEntry.boundingClientRect?.height;
              recordMeasuredHeight(heightsRef.current, flowKey, target, measured);
            }
            if (next.has(flowKey)) {
              next.delete(flowKey);
              changed = true;
            }
          }
        }
        if (!ioSettledRef.current) {
          ioSettledRef.current = true;
          setIoSettledState((prev) =>
            prev.sessionId === sessionId && prev.settled ? prev : { sessionId, settled: true },
          );
        }
        if (changed) {
          visibleKeysRef.current = next;
          setVisibleState({ sessionId, keys: next });
        }
      },
      { root, rootMargin: effectiveOverscanMargin },
    );
    ioRef.current = observer;
    for (const element of rowElementsRef.current.values()) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
      if (ioRef.current === observer) ioRef.current = null;
    };
  }, [effectiveOverscanMargin, enabled, listRef, sessionId]);

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
    const list = listRef.current;
    const scroller = list?.closest("[data-conversation-scroll]") ?? list ?? null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isFindShortcut(event)) {
        activateFindLease();
        return;
      }
      if (!findLeaseActiveRef.current) return;
      if (event.key === "Escape") {
        releaseFindLease();
      } else if (isFindRenewalKey(event)) {
        renewFindLease();
      }
    };
    const onBeforeMatch = (): void => {
      if (findLeaseActiveRef.current) renewFindLease();
    };
    const onEditableFocusIn = (event: FocusEvent): void => {
      if (findLeaseActiveRef.current && isEditableEventTarget(event.target)) {
        releaseFindLease();
      }
    };
    const onFindScroll = (): void => {
      if (findLeaseActiveRef.current) renewFindLease();
    };
    const onFindSelectionChange = (): void => {
      if (!findLeaseActiveRef.current) return;
      const selection = document.getSelection();
      if (selection !== null && selection.rangeCount > 0 && !selection.isCollapsed) {
        renewFindLease();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("beforematch", onBeforeMatch, true);
    document.addEventListener("focusin", onEditableFocusIn, true);
    document.addEventListener("selectionchange", onFindSelectionChange);
    scroller?.addEventListener("scroll", onFindScroll, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("beforematch", onBeforeMatch, true);
      document.removeEventListener("focusin", onEditableFocusIn, true);
      document.removeEventListener("selectionchange", onFindSelectionChange);
      scroller?.removeEventListener("scroll", onFindScroll);
    };
  }, [activateFindLease, enabled, listRef, releaseFindLease, renewFindLease, sessionId]);

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

  const virtualizing = enabled && ioSettled && !findLeaseActive;
  const tailStartIndex = Math.max(0, entries.length - PIN_TAIL);
  const activeVisibleKeys = virtualizing ? visibleKeys : null;
  const activePinnedKeys = virtualizing ? pinnedKeys : null;
  const activeSelectionBounds = virtualizing ? selectionBounds : null;
  const activeTailStartIndex = virtualizing ? tailStartIndex : 0;

  const isMounted = useCallback(
    (index: number, flowKey: string): boolean => {
      if (!virtualizing) return true;
      if (index >= activeTailStartIndex) return true;
      if (activeVisibleKeys !== null && activeVisibleKeys.has(flowKey)) return true;
      if (activePinnedKeys !== null && activePinnedKeys.has(flowKey)) return true;
      if (
        activeSelectionBounds !== null &&
        index >= activeSelectionBounds.start &&
        index <= activeSelectionBounds.end
      )
        return true;
      return false;
    },
    [
      activePinnedKeys,
      activeSelectionBounds,
      activeTailStartIndex,
      activeVisibleKeys,
      virtualizing,
    ],
  );

  // Maintain the set of currently mounted flow keys and observe only mounted rows with ResizeObserver.
  const currentMountedKeys = useMemo(() => {
    if (!enabled) return EMPTY_MOUNTED_KEYS;
    const set = new Set<string>();
    for (let i = 0; i < entries.length; i += 1) {
      const key = flowKeys[i]!;
      if (isMounted(i, key)) set.add(key);
    }
    return set;
  }, [enabled, entries.length, flowKeys, isMounted]);

  // Capture a viewport anchor before commit when rows above the viewport mount or
  // unmount, keeping reading scroll position stable deterministically across engines
  // and recovering from synchronous layout clamps. Also mark tail-following commits.
  pendingScrollCompensationRef.current = null;
  pendingTailRestoreRef.current = null;
  if (enabled && mountedKeysRef.current.size > 0) {
    const prevMounted = mountedKeysRef.current;
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>("[data-conversation-scroll]") ?? list ?? null;
    if (scroller !== null && scroller.isConnected) {
      const floor = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const prevScrollTop = scroller.scrollTop;
      const followingTailAttr = list?.closest("[data-chat-following-tail]") !== null;
      const nearTail = floor <= 0 || floor - prevScrollTop <= FOLLOW_BOTTOM_THRESHOLD_PX;
      if (nearTail) {
        if (followingTailAttr && floor > 0 && mountedSetChanged(prevMounted, currentMountedKeys)) {
          pendingTailRestoreRef.current = scroller;
        }
      } else {
        const scrollerTop = scroller.getBoundingClientRect().top;
        const elements = rowElementsRef.current;
        let hasAboveViewportChange = false;
        for (const flowKey of currentMountedKeys) {
          if (prevMounted.has(flowKey)) continue;
          const el = elements.get(flowKey);
          if (el === undefined || !el.isConnected || el.hasAttribute("hidden")) continue;
          if (el.getBoundingClientRect().top < scrollerTop) {
            hasAboveViewportChange = true;
            break;
          }
        }
        if (!hasAboveViewportChange) {
          for (const flowKey of prevMounted) {
            if (currentMountedKeys.has(flowKey)) continue;
            const el = elements.get(flowKey);
            if (el === undefined || !el.isConnected || el.hasAttribute("hidden")) continue;
            if (el.getBoundingClientRect().top < scrollerTop) {
              hasAboveViewportChange = true;
              break;
            }
          }
        }
        if (hasAboveViewportChange) {
          let bestAnchor: HTMLElement | null = null;
          let bestTop = Number.POSITIVE_INFINITY;
          let fallbackAnchor: HTMLElement | null = null;
          let fallbackTop = Number.POSITIVE_INFINITY;
          for (const flowKey of prevMounted) {
            if (!currentMountedKeys.has(flowKey)) continue;
            const el = elements.get(flowKey);
            if (el === undefined || !el.isConnected || el.hasAttribute("hidden")) continue;
            const rect = el.getBoundingClientRect();
            if (rect.bottom <= scrollerTop) continue;
            if (rect.top >= scrollerTop && rect.top < bestTop) {
              bestAnchor = el;
              bestTop = rect.top;
            } else if (rect.top < fallbackTop) {
              fallbackAnchor = el;
              fallbackTop = rect.top;
            }
          }
          if (bestAnchor === null && fallbackAnchor === null) {
            for (const el of elements.values()) {
              if (!el.isConnected || el.hasAttribute("hidden")) continue;
              const rect = el.getBoundingClientRect();
              if (rect.bottom <= scrollerTop) continue;
              if (rect.top >= scrollerTop && rect.top < bestTop) {
                bestAnchor = el;
                bestTop = rect.top;
              }
            }
          }
          const anchorEl = bestAnchor ?? fallbackAnchor;
          const prevTop = bestAnchor !== null ? bestTop : fallbackTop;
          if (anchorEl !== null && Number.isFinite(prevTop)) {
            pendingScrollCompensationRef.current = {
              scroller,
              anchorEl,
              prevTop,
              prevScrollTop,
              scrollVersion: scrollVersionRef.current,
            };
          }
        }
      }
    }
  }

  useLayoutEffect(() => {
    const prevMounted = mountedKeysRef.current;
    mountedKeysRef.current = currentMountedKeys;

    const pendingTailRestore = pendingTailRestoreRef.current;
    pendingTailRestoreRef.current = null;
    if (pendingTailRestore !== null && pendingTailRestore.isConnected) {
      const nextFloor = Math.max(
        0,
        pendingTailRestore.scrollHeight - pendingTailRestore.clientHeight,
      );
      if (nextFloor > 0 && nextFloor - pendingTailRestore.scrollTop > 0.5) {
        if (onTailScrollClampRef.current !== undefined) {
          onTailScrollClampRef.current();
        } else {
          pendingTailRestore.scrollTop = nextFloor;
        }
      }
    }

    const pendingCompensation = pendingScrollCompensationRef.current;
    pendingScrollCompensationRef.current = null;
    if (
      pendingCompensation !== null &&
      pendingCompensation.scroller.isConnected &&
      pendingCompensation.anchorEl.isConnected &&
      pendingCompensation.scrollVersion === scrollVersionRef.current
    ) {
      const beforeScrollTop = pendingCompensation.scroller.scrollTop;
      const nextTop = pendingCompensation.anchorEl.getBoundingClientRect().top;
      const delta = nextTop - pendingCompensation.prevTop;
      if (Math.abs(delta) > 0.5) {
        pendingCompensation.scroller.scrollTop = beforeScrollTop + delta;
        const netDelta = pendingCompensation.scroller.scrollTop - pendingCompensation.prevScrollTop;
        if (Math.abs(netDelta) > 0.01) {
          onScrollCompensatedRef.current?.(netDelta);
        }
      }
    }

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
      const isNewlyMountedOrUnobserved =
        ro !== null ? !observed.has(el) : !prevMounted.has(flowKey);
      if (isNewlyMountedOrUnobserved || !heightsRef.current.has(flowKey)) {
        recordMeasuredHeight(heightsRef.current, flowKey, el);
      }
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
    // When a mounted row transitions out of the mounted set on this render, sample
    // its live DOM height right before commit so dynamic height changes never
    // collapse the placeholder to a stale cached value.
    if (mountedKeysRef.current.has(flowKey)) {
      const liveEl = rowElementsRef.current.get(flowKey);
      if (
        liveEl !== undefined &&
        !liveEl.hasAttribute("hidden") &&
        !liveEl.hasAttribute("data-chat-virtualized")
      ) {
        const liveHeight = readElementHeight(liveEl);
        if (liveHeight > 0) {
          const normalized = normalizeMeasuredHeight(liveHeight);
          heightsRef.current.set(flowKey, normalized);
          return normalized;
        }
        if (isEmptyRowShell(liveEl)) {
          heightsRef.current.set(flowKey, 0);
          return 0;
        }
      }
    }
    const cached = heightsRef.current.get(flowKey);
    if (cached !== undefined) return cached;
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
