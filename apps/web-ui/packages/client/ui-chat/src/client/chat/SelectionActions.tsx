/**
 * Selection actions over assistant responses: selecting text inside one
 * finished answer offers "Add to chat", which attaches the passage to the
 * Composer as a response annotation.
 *
 * The selection must start and end inside the same answer, and must not touch
 * chrome the answer does not own as prose (code-block toolbars, composer
 * editors): a passage spanning two answers, or one anchored inside a control,
 * has no single owner and is ignored. Placement follows Desktop — 8px above
 * the selection, drawn upward — except on a touch platform, where the native
 * callout opens above the selection and the action stays below it instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import css from "./SelectionActions.module.css";

/** Chrome that never contributes selected prose, excluded from the counted text. */
const EXCLUDED_SELECTION = [
  "[data-code-block-controls]",
  "[data-selection-actions]",
  "[contenteditable='true']",
].join(",");

/** Owner-provided copy for the action. */
export interface SelectionActionsLabels {
  /** Button label: attach the selection to the chat. */
  readonly addToChat: string;
}

/** One resolved selection inside an answer. */
interface AnswerSelection {
  /** Selected text, trimmed. */
  readonly text: string;
  /** Viewport rect of the selection's last line. */
  readonly rect: DOMRect;
  /** Element that owns the selection (the answer body). */
  readonly host: Element;
}

const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 8;

/**
 * Read the current selection when it belongs to exactly one answer body.
 * @param root - the scrolling transcript that holds every rendered answer.
 * @returns the selection, or undefined for a collapsed, empty, or cross-owner range.
 */
function readSelection(root: Element | null): AnswerSelection | undefined {
  if (root === null || typeof window === "undefined") return undefined;
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  const hostOf = (node: Node | null): Element | undefined => {
    const element = node instanceof Element ? node : (node?.parentElement ?? undefined);
    if (element === undefined || element === null) return undefined;
    const host = element.closest("[data-selection-answer]");
    return host !== null && root.contains(host) ? host : undefined;
  };
  const host = hostOf(range.startContainer);
  if (host === undefined || hostOf(range.endContainer) !== host) return undefined;
  if (host.closest("[data-selection-answer-streaming]") !== null) return undefined;
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const end =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  if (start?.closest(EXCLUDED_SELECTION) != null || end?.closest(EXCLUDED_SELECTION) != null)
    return undefined;
  const text = selectedText(range);
  if (text === "") return undefined;
  const rects = range.getClientRects();
  const rect = rects.length === 0 ? range.getBoundingClientRect() : rects[rects.length - 1]!;
  if (rect.width === 0 && rect.height === 0) return undefined;
  return { text, rect, host };
}

/** Blocks whose edges are line breaks of their own, as Desktop's serializer reads them. */
const BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "PRE",
]);

/**
 * The selection's text, read the way Desktop's own selection extractor reads
 * it: block edges become line breaks, a paragraph that follows another keeps a
 * blank line between them, `<br>` is one newline, table cells are tab
 * separated, and a list is its items' text — Desktop inserts a newline where
 * the list sat and never writes markers or numbers of its own.
 * @param range - the live range.
 * @returns the trimmed prose the user sees selected.
 */
function selectedText(range: Range): string {
  const fragment = range.cloneContents();
  const container = document.createElement("div");
  container.append(fragment);
  for (const excluded of container.querySelectorAll(EXCLUDED_SELECTION)) excluded.remove();
  // A list stands where its text stands: Desktop replaces it with a newline
  // followed by the list's own children before projecting text.
  for (const list of container.querySelectorAll("ol, ul"))
    list.replaceWith("\n", ...list.childNodes);
  return serialize(container).trim();
}

function serialize(parent: Element): string {
  let text = "";
  for (const child of parent.childNodes) text += serializeNode(child, parent);
  return text;
}

function serializeNode(node: Node, parent: Element): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  switch (node.tagName) {
    case "BR":
      return "\n";
    case "TABLE":
      return Array.from(node.querySelectorAll("tr")).map(serializeRow).join("\n");
    case "TD":
    case "TH":
      // A range between cell text nodes clones the cells without their row.
      return `${node.previousElementSibling?.matches("td, th") ? "\t" : ""}${serialize(node).trimEnd()}`;
    case "TR":
      return serializeRow(node);
    case "THEAD":
    case "TBODY":
    case "TFOOT":
      return serialize(node);
    case "P":
      return serializeParagraph(node, parent);
    default: {
      const text = serialize(node);
      return BLOCK_TAGS.has(node.tagName) ? `${text}\n` : text;
    }
  }
}

function serializeRow(row: Element): string {
  return Array.from(row.children)
    .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
    .map((cell) => serialize(cell).trim())
    .join("\t");
}

function serializeParagraph(node: Element, parent: Element): string {
  const previous = node.previousElementSibling;
  const separated =
    previous?.tagName === "P" &&
    previous.textContent?.trim() !== "" &&
    node.textContent?.trim() !== "" &&
    parent.tagName !== "LI"
      ? "\n"
      : "";
  return `${separated}${serialize(node)}\n`;
}

/**
 * Where the action sits. Web anchors its right edge at the selection's
 * right edge 8px above the selection's top and draws the box upward, keeping
 * the box inside the viewport with a CSS clamp rather than assuming its width;
 * a touch platform draws it below the selection instead, so the system callout
 * above stays reachable.
 * @param rect - the selection's last line in viewport coordinates.
 * @returns fixed-position anchor and the transform that bounds the box.
 */
function placeSelection(rect: DOMRect): {
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
  const below = window.matchMedia("(hover: none)").matches;
  // The clamp bounds the drawn box: its own width decides how far left it may
  // pull itself, and its right edge never leaves the viewport margin.
  const room = width - VIEWPORT_MARGIN - right;
  return {
    left: right,
    top: below ? rect.bottom + POPOVER_GAP : rect.top - POPOVER_GAP,
    maxWidth: width - VIEWPORT_MARGIN * 2,
    transform:
      `translateX(clamp(${String(VIEWPORT_MARGIN - right)}px, -100%, calc(${String(room)}px - 100%)))` +
      (below ? "" : " translateY(-100%)"),
    below,
  };
}

/**
 * Watch answers for selections and offer the attach action next to them.
 * @param props.labels - localized action copy.
 * @param props.onAdd - attaches the selected text; false keeps the selection available.
 * @param props.container - transcript element whose answers participate.
 * @returns the popover, or null while nothing is selected.
 */
export function SelectionActions({
  labels,
  onAdd,
  container,
}: {
  labels: SelectionActionsLabels;
  onAdd: (text: string) => boolean;
  container: () => Element | null;
}): ReactNode {
  const [selection, setSelection] = useState<AnswerSelection | null>(null);
  const frameRef = useRef<number | null>(null);
  const suppressRef = useRef(false);

  const sync = useCallback(() => {
    frameRef.current = null;
    if (suppressRef.current) return;
    const next = readSelection(container());
    setSelection((current) =>
      current?.text === next?.text && current?.rect.top === next?.rect.top
        ? current
        : (next ?? null),
    );
  }, [container]);

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
      if (
        target instanceof Node &&
        target.parentElement?.closest("[data-selection-actions]") != null
      )
        return;
      suppressRef.current = true;
      setSelection(null);
    };
    const onSelectionChange = (): void => {
      const live = window.getSelection();
      if (live === null || live.rangeCount === 0 || live.isCollapsed) {
        setSelection(null);
        return;
      }
      schedule();
    };
    const onScroll = (): void => {
      setSelection(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("keyup", schedule);
    // Capture also observes non-bubbling scrolls in the containing chat scrollport.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("keyup", schedule);
      window.removeEventListener("scroll", onScroll, true);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [schedule]);

  if (selection === null) return null;
  const placed = placeSelection(selection.rect);
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
    >
      <button
        type="button"
        className={css.action}
        onPointerDown={(event) => {
          // Keeping focus on the control preserves the DOM selection until the
          // click handler reads it.
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={() => {
          if (!onAdd(selection.text)) return;
          window.getSelection()?.removeAllRanges();
          setSelection(null);
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
    </div>,
    document.body,
  );
}
