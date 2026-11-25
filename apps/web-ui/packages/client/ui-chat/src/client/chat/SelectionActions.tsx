/**
 * Selection actions over assistant responses: selecting text inside one
 * finished answer offers "Add to chat", which attaches the passage to the
 * Composer as a response annotation, and "Comment", which opens a note field
 * beside the passage and attaches both together.
 *
 * Moving focus into the note field collapses the browser selection, so the
 * passage is captured when the field opens and the selection listeners stand
 * down until it closes.
 *
 * The selection must start and end inside the same answer, and must not touch
 * chrome the answer does not own as prose (code-block toolbars, composer
 * editors): a passage spanning two answers, or one anchored inside a control,
 * has no single owner and is ignored. Placement follows Desktop — 8px above
 * the selection, drawn upward — except on a touch platform, where the native
 * callout opens above the selection and the action stays below it instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import type {
  DraftResponseAnnotationInput,
  ResponseAnnotationAnchor,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { highlightResponseRanges, lastSelectionRect } from "./ResponseAnnotationMarks.tsx";
import {
  EXCLUDED_SELECTION,
  captureResponseAnnotationAnchor,
  selectedText,
} from "./response-selection.ts";
import css from "./SelectionActions.module.css";
import { COMMENT_CARD_HEIGHT, SelectionCommentCard } from "./SelectionCommentCard.tsx";
import type { SelectionCommentLabels } from "./SelectionCommentCard.tsx";

/** Owner-provided copy for the action. */
export interface SelectionActionsLabels extends SelectionCommentLabels {
  /** Button label: attach the selection to the chat. */
  readonly addToChat: string;
  /** Button label: attach the selection with a note of the user's own. */
  readonly comment: string;
}

/** One resolved selection inside an answer. */
interface AnswerSelection {
  /** Selected text, trimmed. */
  readonly text: string;
  /** Viewport rect of the selection's last line. */
  readonly rect: DOMRect;
  /** A range snapshot retained while the page selection is focused elsewhere. */
  readonly range: Range;
  /** Element that owns the selection (the answer body). */
  readonly host: Element;
}

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 8;

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/**
 * Read the current selection when it belongs to exactly one answer body.
 * @param root - the scrolling transcript that holds every rendered answer.
 * @returns the selection, or null for a collapsed, empty, or cross-owner range.
 */
function readSelection(root: Element | null): AnswerSelection | null {
  if (root === null || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const host = start?.closest("[data-selection-answer]");
  if (
    host === null ||
    host === undefined ||
    !root.contains(host) ||
    end?.closest("[data-selection-answer]") !== host ||
    host.hasAttribute("data-selection-answer-streaming") ||
    start?.closest(EXCLUDED_SELECTION) != null ||
    end?.closest(EXCLUDED_SELECTION) != null
  )
    return null;
  const text = selectedText(range);
  const rect = lastSelectionRect(range);
  return text === "" || rect === undefined ? null : { text, rect, range: range.cloneRange(), host };
}

function clearSelection(host: Element): void {
  const live = window.getSelection();
  if (live !== null && host.contains(live.anchorNode) && host.contains(live.focusNode))
    live.removeAllRanges();
}

/**
 * Where the action sits. Web anchors its right edge at the selection's
 * right edge 8px above the selection's top and draws the box upward, keeping
 * the box inside the viewport with a CSS clamp rather than assuming its width;
 * a touch platform draws it below the selection instead, so the system callout
 * above stays reachable. The comment card can flip sides or move away from
 * the selection to stay within the visible viewport.
 * @param rect - the selection's last line in viewport coordinates.
 * @param height - the box's height; omit for the one-line action.
 * @returns fixed-position anchor and the transform that bounds the box.
 */
function placeSelection(
  rect: DOMRect,
  height = 0,
): {
  left: number;
  top: number;
  maxWidth: number;
  transform: string;
  below: boolean;
} {
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const right = rect.right - offsetLeft;
  const touch = window.matchMedia("(hover: none)").matches;
  const topEdge = viewport?.offsetTop ?? 0;
  const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight);
  const fitsAbove = rect.top - POPOVER_GAP - height >= topEdge + VIEWPORT_MARGIN;
  const fitsBelow = rect.bottom + POPOVER_GAP + height <= bottomEdge - VIEWPORT_MARGIN;
  const below = height === 0 ? touch : touch ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
  // The clamp bounds the drawn box: its own width decides how far left it may
  // pull itself, and its right edge never leaves the viewport margin.
  const room = width - VIEWPORT_MARGIN - right;
  const top = below ? rect.bottom + POPOVER_GAP : rect.top - POPOVER_GAP;
  const minTop = topEdge + VIEWPORT_MARGIN + (below ? 0 : height);
  const maxTop = bottomEdge - VIEWPORT_MARGIN - (below ? height : 0);
  return {
    left: rect.right,
    top: height === 0 ? top : Math.max(minTop, Math.min(top, maxTop)),
    maxWidth: width - VIEWPORT_MARGIN * 2,
    transform:
      `translateX(clamp(${String(VIEWPORT_MARGIN - right)}px, -100%, calc(${String(room)}px - 100%)))` +
      (below ? "" : " translateY(-100%)"),
    below,
  };
}

interface ComposingSelection extends AnswerSelection {
  readonly anchor: ResponseAnnotationAnchor | undefined;
  readonly placement: ReturnType<typeof placeSelection>;
}

/**
 * Watch answers for selections and offer the attach actions next to them.
 * @param props.labels - localized action copy.
 * @param props.onAdd - attaches the selected text; false keeps the selection available.
 * @param props.container - transcript element whose answers participate.
 * @returns the popover or the note field, or null while nothing is selected.
 */
export function SelectionActions({
  labels,
  onAdd,
  container,
}: {
  labels: SelectionActionsLabels;
  onAdd: (annotation: DraftResponseAnnotationInput) => boolean;
  container: RefObject<Element>;
}): ReactNode {
  const [selection, setSelection] = useState<AnswerSelection | null>(null);
  // The passage a note is being written for. Held apart from `selection`: the
  // field takes focus, which collapses the page selection `selection` mirrors.
  const [composing, setComposing] = useState<ComposingSelection | null>(null);
  const commentFieldRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const suppressRef = useRef(false);
  // Selection dismissed with Escape stays suppressed until the user clears or changes selection.
  const dismissedRef = useRef<{ host: Element; text: string } | null>(null);
  const visibleSelectionRef = useRef<AnswerSelection | null>(null);

  const updateSelection = useCallback((next: AnswerSelection | null) => {
    visibleSelectionRef.current = next;
    setSelection(next);
  }, []);

  const closeComposing = useCallback(() => {
    composingRef.current = false;
    setComposing(null);
  }, []);

  const sync = useCallback(() => {
    frameRef.current = null;
    if (suppressRef.current || composingRef.current) return;
    // Keep the latest range endpoints even when the selected text and line
    // remain unchanged; repeated prose can otherwise retain an old anchor.
    const next = readSelection(container.current);
    const dismissed = dismissedRef.current;
    if (
      next !== null &&
      dismissed !== null &&
      next.host === dismissed.host &&
      next.text === dismissed.text
    ) {
      updateSelection(null);
      return;
    }
    if (
      next === null ||
      dismissed === null ||
      next.host !== dismissed.host ||
      next.text !== dismissed.text
    ) {
      dismissedRef.current = null;
    }
    updateSelection(next);
  }, [container, updateSelection]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(sync);
  }, [sync]);

  useEffect(() => {
    // A pointer release ends a drag selection; keyboard and double-click
    // selection settle without one.
    const onPointerUp = (): void => {
      suppressRef.current = false;
      schedule();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // The note card is itself a `data-selection-actions` element, so a press
      // on its padding must count as inside; `closest` starts at the element.
      const origin =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      if (origin?.closest("[data-selection-actions]") != null) return;
      suppressRef.current = true;
      dismissedRef.current = null;
      updateSelection(null);
      closeComposing();
    };
    const onSelectionChange = (): void => {
      const live = window.getSelection();
      if (live === null || live.rangeCount === 0 || live.isCollapsed) {
        dismissedRef.current = null;
        updateSelection(null);
        return;
      }
      schedule();
    };
    const onScroll = (event: Event): void => {
      // The note field scrolls itself when its text overflows; that is not
      // the transcript moving away from the passage.
      const target = event.target;
      if (target instanceof Element && target.closest("[data-selection-actions]") !== null) return;
      // Opening the keyboard can also scroll the transcript. Keep the card
      // mounted while editing or when closing it would discard a draft.
      const field = commentFieldRef.current;
      if (field !== null && (field === document.activeElement || field.value !== "")) return;
      updateSelection(null);
      closeComposing();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const visible = visibleSelectionRef.current;
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        composingRef.current ||
        visible === null
      )
        return;
      event.preventDefault();
      dismissedRef.current = { host: visible.host, text: visible.text };
      updateSelection(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", schedule);
    // Capture also observes non-bubbling scrolls in the containing chat scrollport.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", schedule);
      window.removeEventListener("scroll", onScroll, true);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [schedule, closeComposing, updateSelection]);

  const composingRect = composing?.rect;
  const composingRange = composing?.range;
  useEffect(() => {
    if (composingRect === undefined || composingRange === undefined) return;
    const viewport = window.visualViewport;
    const card = commentFieldRef.current?.closest<HTMLElement>("[data-selection-actions]");
    const reposition = (): void => {
      const height = card?.offsetHeight ?? COMMENT_CARD_HEIGHT;
      const placement = placeSelection(composingRect, height);
      setComposing((current) =>
        current?.rect === composingRect ? { ...current, placement } : current,
      );
    };
    const clearHighlight = highlightResponseRanges([composingRange]);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (card != null) resize?.observe(card);
    window.addEventListener("resize", reposition);
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition, { passive: true });
    reposition();
    return () => {
      clearHighlight();
      resize?.disconnect();
      window.removeEventListener("resize", reposition);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    };
  }, [composingRect, composingRange]);

  /** Whether the answer a passage came from is still on the page. */
  const owned = (passage: AnswerSelection): boolean =>
    passage.host.isConnected && container.current?.contains(passage.host) === true;

  if (composing !== null) {
    const placed = composing.placement;
    return createPortal(
      <SelectionCommentCard
        excerpt={composing.text}
        labels={labels}
        fieldRef={commentFieldRef}
        below={placed.below}
        style={{
          left: placed.left,
          top: placed.top,
          maxWidth: placed.maxWidth,
          transform: `${placed.transform} translateZ(0)`,
        }}
        onSubmit={(comment) => {
          if (!owned(composing)) return false;
          const annotation: DraftResponseAnnotationInput =
            composing.anchor === undefined
              ? { text: composing.text, annotation: comment }
              : { text: composing.text, annotation: comment, anchor: composing.anchor };
          if (!onAdd(annotation)) return false;
          clearSelection(composing.host);
          closeComposing();
          return true;
        }}
        onCancel={closeComposing}
      />,
      document.body,
    );
  }
  if (selection === null) return null;
  const placed = placeSelection(selection.rect);
  const stillInTranscript = (): boolean =>
    selection.host.isConnected && container.current?.contains(selection.host) === true;
  return createPortal(
    <div
      className={css.popover}
      data-placement={placed.below ? "below" : "above"}
      style={{
        left: placed.left,
        top: placed.top,
        maxWidth: placed.maxWidth,
        transform: `${placed.transform} translateZ(0)`,
      }}
      data-selection-actions
      onPointerDown={(event) => {
        // Keep focus on the control so the captured range remains meaningful.
        event.preventDefault();
      }}
    >
      <button
        type="button"
        className={css.action}
        onClick={() => {
          if (!stillInTranscript()) return;
          const anchor = captureResponseAnnotationAnchor(selection.host, selection.range);
          const annotation: DraftResponseAnnotationInput =
            anchor === undefined ? { text: selection.text } : { text: selection.text, anchor };
          if (!onAdd(annotation)) return;
          clearSelection(selection.host);
          updateSelection(null);
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M12 7v6" />
          <path d="M9 10h6" />
        </svg>
        <span>{labels.addToChat}</span>
      </button>
      <button
        type="button"
        className={css.action}
        onClick={() => {
          if (!stillInTranscript()) return;
          // Capture the live range before the card focuses its input and the
          // browser collapses the page selection. A missing anchor is valid:
          // the text-only comment remains attachable.
          const anchor = captureResponseAnnotationAnchor(selection.host, selection.range);
          clearSelection(selection.host);
          // Set before state so a selection frame already queued sees the card.
          composingRef.current = true;
          setComposing({
            ...selection,
            anchor,
            placement: placeSelection(selection.rect, COMMENT_CARD_HEIGHT),
          });
          updateSelection(null);
        }}
      >
        <span>{labels.comment}</span>
      </button>
    </div>,
    document.body,
  );
}
