/**
 * One response-annotation reference: the composer rail entry, the inline label
 * a reply uses, and the card both open. Presentation only — the annotation's
 * text and comment arrive from the message that carries them.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconCloseFillRegular, IconCloseOutlineRegular } from "./icons/index.tsx";
import { observeComposition } from "./keyboard-composition.ts";
import { overlayTopMargin } from "./overlay-top-margin.ts";
import { useDismissOnOutsidePointer } from "./useDismissOnOutsidePointer.ts";
import css from "./ResponseAnnotation.module.css";

/** Localized strings for the annotation card and its triggers. */
export interface ResponseAnnotationLabels {
  /** Visible label of annotation N, e.g. "Annotation 1". */
  label: (index: number) => string;
  /** Rail entry body, e.g. "1.". */
  railLabel: (index: number) => string;
  /** Card heading above the quoted selection. */
  selectedText: string;
  /** Card heading above the optional comment. */
  userComment: string;
  /** Accessible name of a rail entry. */
  railTitle: (index: number, excerpt: string) => string;
  /** Remove-button label. */
  remove: (index: number) => string;
}

/** One annotation's content as both the rail and the inline label show it. */
export interface ResponseAnnotationView {
  /** Selected text, already trimmed. */
  readonly text: string;
  /** Optional user comment. */
  readonly annotation?: string;
}

const MAX_RAIL_EXCERPT = 48;
const CARD_WIDTH = 320;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

/** One line of the rail entry: the selection with its line breaks folded. */
function excerptOf(text: string): string {
  const folded = text.replace(/\s+/gu, " ").trim();
  return folded.length <= MAX_RAIL_EXCERPT ? folded : `${folded.slice(0, MAX_RAIL_EXCERPT - 1)}…`;
}

/**
 * The annotation body: quoted selection, then the optional comment.
 * @param props.annotation - the annotation to describe.
 * @param props.labels - localized headings.
 * @returns the card content.
 */
export function ResponseAnnotationCard({
  annotation,
  labels,
}: {
  annotation: ResponseAnnotationView;
  labels: ResponseAnnotationLabels;
}): ReactNode {
  const multiline = annotation.text.includes("\n");
  return (
    <div className={css.card}>
      <div className={css.cardSection}>
        <div className={css.cardHeading}>{labels.selectedText}</div>
        {multiline ? (
          <pre className={css.cardPre} tabIndex={0}>
            {annotation.text}
          </pre>
        ) : (
          <div className={css.cardText}>{annotation.text}</div>
        )}
      </div>
      {annotation.annotation === undefined ? null : (
        <div className={css.cardSection}>
          <div className={css.cardHeading}>{labels.userComment}</div>
          <div className={css.cardText}>{annotation.annotation}</div>
        </div>
      )}
    </div>
  );
}

/** Anchor geometry of an open card, resolved before paint and while it is open. */
interface CardPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

/**
 * Show the annotation card anchored to a trigger, dismissed by an outside
 * pointer or Escape.
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.annotation - content of the card.
 * @param props.labels - localized headings.
 * @param props.className - anchor styling from the caller.
 * @param props.open - opens the card on mount (the rail entry's first paint).
 * @param props.onActivate - runs when the trigger is clicked, before toggling the card.
 * @returns the trigger and, while open, its portaled card.
 */
export function ResponseAnnotationPopover({
  anchor,
  annotation,
  labels,
  className,
  title,
  open: initialOpen = false,
  onActivate,
}: {
  anchor: ReactNode;
  annotation: ResponseAnnotationView;
  labels: ResponseAnnotationLabels;
  className?: string | undefined;
  title?: string | undefined;
  open?: boolean;
  onActivate?: (() => void) | undefined;
}): ReactNode {
  const [open, setOpen] = useState(initialOpen);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CardPosition | null>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismissOnOutsidePointer(anchorRef, open, close, cardRef);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
    };
  }, [open, close]);
  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const trigger = anchorRef.current?.getBoundingClientRect();
      if (trigger === undefined) return;
      const width = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const topMargin = overlayTopMargin(VIEWPORT_MARGIN);
      const belowTop = Math.max(topMargin, trigger.bottom + CARD_GAP);
      const above = Math.max(0, trigger.top - CARD_GAP - topMargin);
      const below = Math.max(0, window.innerHeight - belowTop - VIEWPORT_MARGIN);
      // Height is known once the card is laid out; the caller re-places after
      // mount, so a card that does not fit below sits flush above the trigger.
      const height = Math.min(cardRef.current?.offsetHeight ?? 0, above);
      const onTop = below < 80 && above > below;
      setPosition({
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(trigger.left, window.innerWidth - width - VIEWPORT_MARGIN),
        ),
        top: onTop ? Math.max(topMargin, trigger.top - CARD_GAP - height) : belowTop,
        width,
        maxHeight: onTop ? above : below,
      });
    };
    place();
    // The card's measured height feeds the placement, so place again once it
    // is in the DOM rather than guessing a height up front.
    const settle = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(settle);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return (
    <span ref={anchorRef} className={clsx(css.triggerSeat, className)}>
      <button
        type="button"
        className={css.trigger}
        title={title}
        aria-expanded={open}
        onClick={() => {
          onActivate?.();
          setOpen((current) => !current);
        }}
      >
        {anchor}
      </button>
      {open &&
        position !== null &&
        createPortal(
          <div
            ref={cardRef}
            className={css.popover}
            role="dialog"
            aria-label={labels.selectedText}
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.maxHeight,
            }}
          >
            <ResponseAnnotationCard annotation={annotation} labels={labels} />
          </div>,
          document.body,
        )}
    </span>
  );
}

/**
 * One composer-rail entry: its one-based number, the selection excerpt, and
 * the remove affordance; activating the body opens the card.
 * @param props.index - one-based annotation position.
 * @param props.annotation - the annotation.
 * @param props.labels - localized strings.
 * @param props.onActivate - runs when the chip body is clicked, before toggling the card.
 * @param props.onRemove - removes this annotation from the draft.
 * @returns the rail entry.
 */
export function ResponseAnnotationChip({
  index,
  annotation,
  labels,
  onActivate,
  onRemove,
}: {
  index: number;
  annotation: ResponseAnnotationView;
  labels: ResponseAnnotationLabels;
  onActivate?: (() => void) | undefined;
  /** Omitted for a sent message: its annotations are history and cannot be removed. */
  onRemove?: (() => void) | undefined;
}): ReactNode {
  return (
    <div className={css.chip} data-response-annotation={index}>
      <ResponseAnnotationPopover
        annotation={annotation}
        labels={labels}
        title={labels.railTitle(index, excerptOf(annotation.text))}
        className={css.chipBody}
        onActivate={onActivate}
        anchor={
          <>
            <span className={css.chipNumber}>{labels.railLabel(index)}</span>
            <span className={css.chipText}>{excerptOf(annotation.text)}</span>
          </>
        }
      />
      {onRemove === undefined ? null : (
        <button
          type="button"
          className={css.chipRemove}
          aria-label={labels.remove(index)}
          onClick={onRemove}
        >
          <IconCloseFillRegular size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * The inline label a reply uses once per answered annotation.
 * @param props.index - one-based annotation position.
 * @param props.annotation - the annotation, absent when the message no longer resolves it.
 * @param props.labels - localized strings.
 * @returns the label, opening the card only when the annotation is known.
 */
export function ResponseAnnotationLabel({
  index,
  annotation,
  labels,
}: {
  index: number;
  annotation: ResponseAnnotationView | undefined;
  labels: ResponseAnnotationLabels;
}): ReactNode {
  if (annotation === undefined) return <span className={css.label}>{labels.label(index)}</span>;
  return (
    <ResponseAnnotationPopover
      annotation={annotation}
      labels={labels}
      title={labels.railTitle(index, excerptOf(annotation.text))}
      className={css.labelSeat}
      anchor={<span className={css.label}>{labels.label(index)}</span>}
    />
  );
}

/** One unsent annotation entry displayed in the composer's embedded tray. */
export interface ResponseAnnotationTrayItem extends ResponseAnnotationView {
  readonly id: string;
  readonly canReveal?: boolean;
}

/** Localized strings for the embedded composer annotation tray. */
export interface ResponseAnnotationTrayLabels {
  readonly regionAria: string;
  readonly count: (count: number) => string;
  readonly clearAll: string;
  readonly emptyComment: string;
  readonly editHint: (index: number) => string;
  readonly revealHint: (index: number) => string;
  readonly remove: (index: number) => string;
}

const TRAY_EDIT_MAX_HEIGHT = 112;

function supportsFieldSizingContent(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("field-sizing", "content")
  );
}

function syncAutoHeight(field: HTMLTextAreaElement, maxHeight: number): void {
  if (supportsFieldSizingContent()) return;
  field.style.height = "auto";
  field.style.height = `${String(Math.min(field.scrollHeight, maxHeight))}px`;
}

/**
 * Embedded composer annotation tray inspired by Kettu's comment list:
 * shows quoted excerpt + editable comment per row, links hover state with
 * transcript highlights, and supports inline editing and one-click clear-all.
 */
export function ResponseAnnotationTray({
  annotations,
  hoveredId,
  disabled = false,
  labels,
  onHover,
  onReveal,
  onUpdate,
  onRemove,
  onClearAll,
}: {
  annotations: readonly ResponseAnnotationTrayItem[];
  hoveredId?: string | undefined;
  disabled?: boolean | undefined;
  labels: ResponseAnnotationTrayLabels;
  onHover?: ((id: string | null) => void) | undefined;
  onReveal?: ((id: string) => void) | undefined;
  onUpdate?: ((id: string, annotation: string | undefined) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  onClearAll?: (() => void) | undefined;
}): ReactNode {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");
  const editFieldRef = useRef<HTMLTextAreaElement>(null);
  const commentButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const compositionRef = useRef<ReturnType<typeof observeComposition> | null>(null);
  const skipBlurCommitRef = useRef(false);
  const restoreFocusIdRef = useRef<string | null>(null);
  const ownedHoverRef = useRef<string | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const canEdit = !disabled && onUpdate !== undefined;
  const canRemove = !disabled && onRemove !== undefined;
  const canClearAll = !disabled && onClearAll !== undefined;

  const setHovered = useCallback((id: string | null): void => {
    ownedHoverRef.current = id;
    onHoverRef.current?.(id);
  }, []);

  useEffect(() => {
    return () => {
      if (ownedHoverRef.current !== null) {
        ownedHoverRef.current = null;
        onHoverRef.current?.(null);
      }
    };
  }, []);

  useEffect(() => {
    skipBlurCommitRef.current = false;
    if (editingId === null) {
      const targetId = restoreFocusIdRef.current;
      if (targetId !== null) {
        restoreFocusIdRef.current = null;
        commentButtonRefs.current.get(targetId)?.focus({ preventScroll: true });
      }
      return;
    }
    const field = editFieldRef.current;
    if (field !== null) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
    const observer = observeComposition(document);
    compositionRef.current = observer;
    return () => {
      observer.dispose();
      if (compositionRef.current === observer) compositionRef.current = null;
    };
  }, [editingId]);

  useEffect(() => {
    if (editingId === null) return;
    if (disabled || !annotations.some((item) => item.id === editingId)) {
      skipBlurCommitRef.current = true;
      setEditingId(null);
    }
  }, [editingId, annotations, disabled]);

  useLayoutEffect(() => {
    if (editingId === null || editFieldRef.current === null) return;
    syncAutoHeight(editFieldRef.current, TRAY_EDIT_MAX_HEIGHT);
  }, [editingId, draftNote]);

  if (annotations.length === 0) return null;

  const commitEdit = (item: ResponseAnnotationTrayItem, restoreFocus = false): void => {
    const trimmed = draftNote.trim();
    const next = trimmed === "" ? undefined : trimmed;
    if (next !== item.annotation) onUpdate?.(item.id, next);
    if (restoreFocus) restoreFocusIdRef.current = item.id;
    skipBlurCommitRef.current = true;
    setEditingId(null);
  };

  const handleEditKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
    item: ResponseAnnotationTrayItem,
  ): void => {
    if (event.key !== "Escape" && (event.key !== "Enter" || event.shiftKey)) return;
    if (compositionRef.current?.guards(event.nativeEvent) === true) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      restoreFocusIdRef.current = item.id;
      skipBlurCommitRef.current = true;
      setEditingId(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    commitEdit(item, true);
  };

  return (
    <section
      className={css.tray}
      aria-label={labels.regionAria}
      data-composer-annotations
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        setHovered(null);
      }}
    >
      <div className={css.trayHead}>
        <span className={css.trayCount}>{labels.count(annotations.length)}</span>
        {canClearAll && (
          <button
            type="button"
            className={css.trayClear}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              skipBlurCommitRef.current = true;
              setEditingId(null);
              setHovered(null);
              onClearAll();
            }}
          >
            {labels.clearAll}
          </button>
        )}
      </div>
      <ol className={css.trayList}>
        {annotations.map((item, idx) => {
          const number = idx + 1;
          const isHovered = hoveredId === item.id;
          const isEditing = canEdit && editingId === item.id;
          const quotePreview = item.text.replace(/\s+/gu, " ").trim();
          return (
            <li
              key={item.id}
              className={clsx(css.trayRow, isHovered && css.trayRowHovered)}
              data-response-annotation={number}
              data-response-annotation-id={item.id}
              onPointerEnter={(event) => {
                if (event.pointerType === "touch") return;
                setHovered(item.id);
              }}
              onFocus={(event) => {
                if (event.target instanceof Element && event.target.matches(":focus-visible")) {
                  setHovered(item.id);
                }
              }}
              onBlur={(event) => {
                if (
                  !event.currentTarget.contains(event.relatedTarget as Node | null) &&
                  hoveredId === item.id
                ) {
                  setHovered(null);
                }
              }}
            >
              <span
                className={clsx(css.trayNumber, isHovered && css.trayNumberHovered)}
                aria-hidden="true"
              >
                {number}
              </span>
              <div className={css.trayBody}>
                {item.canReveal !== false && onReveal !== undefined ? (
                  <button
                    type="button"
                    className={css.trayQuote}
                    title={labels.revealHint(number)}
                    onClick={() => {
                      onReveal(item.id);
                    }}
                  >
                    {quotePreview}
                  </button>
                ) : (
                  <div className={css.trayQuoteStatic}>{quotePreview}</div>
                )}
                {isEditing ? (
                  <textarea
                    ref={editFieldRef}
                    rows={1}
                    className={css.trayEdit}
                    aria-label={labels.editHint(number)}
                    value={draftNote}
                    onChange={(event) => {
                      setDraftNote(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      handleEditKeyDown(event, item);
                    }}
                    onBlur={() => {
                      if (skipBlurCommitRef.current) {
                        skipBlurCommitRef.current = false;
                        return;
                      }
                      commitEdit(item);
                    }}
                  />
                ) : canEdit ? (
                  <button
                    ref={(node) => {
                      if (node === null) commentButtonRefs.current.delete(item.id);
                      else commentButtonRefs.current.set(item.id, node);
                    }}
                    type="button"
                    className={clsx(css.trayComment, !item.annotation && css.trayCommentEmpty)}
                    aria-label={labels.editHint(number)}
                    title={labels.editHint(number)}
                    onMouseDown={(event) => {
                      if (event.button !== 0 || editingId === null || editingId === item.id) return;
                      // Commit the active row and switch directly so textarea collapse
                      // cannot shift the target button away before click fires.
                      event.preventDefault();
                      const active = annotations.find((entry) => entry.id === editingId);
                      if (active !== undefined) {
                        const trimmed = draftNote.trim();
                        const next = trimmed === "" ? undefined : trimmed;
                        if (next !== active.annotation) onUpdate(active.id, next);
                      }
                      skipBlurCommitRef.current = true;
                      setDraftNote(item.annotation ?? "");
                      setEditingId(item.id);
                    }}
                    onClick={() => {
                      if (editingId === item.id) return;
                      skipBlurCommitRef.current = false;
                      setDraftNote(item.annotation ?? "");
                      setEditingId(item.id);
                    }}
                  >
                    {item.annotation ?? labels.emptyComment}
                  </button>
                ) : (
                  <div
                    className={clsx(
                      css.trayCommentStatic,
                      !item.annotation && css.trayCommentEmpty,
                    )}
                  >
                    {item.annotation ?? labels.emptyComment}
                  </div>
                )}
              </div>
              {canRemove && (
                <button
                  type="button"
                  className={css.trayRemove}
                  aria-label={labels.remove(number)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    if (editingId === item.id) {
                      skipBlurCommitRef.current = true;
                      setEditingId(null);
                    }
                    if (hoveredId === item.id) setHovered(null);
                    onRemove(item.id);
                  }}
                >
                  <IconCloseOutlineRegular size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
