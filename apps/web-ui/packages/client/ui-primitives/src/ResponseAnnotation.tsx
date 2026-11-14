/**
 * One response-annotation reference: the composer rail entry, the inline label
 * a reply uses, and the card both open. Presentation only — the annotation's
 * text and comment arrive from the message that carries them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { IconCloseFillRegular } from "./icons/index.tsx";
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
 * @returns the trigger and, while open, its portaled card.
 */
export function ResponseAnnotationPopover({
  anchor,
  annotation,
  labels,
  className,
  title,
  open: initialOpen = false,
}: {
  anchor: ReactNode;
  annotation: ResponseAnnotationView;
  labels: ResponseAnnotationLabels;
  className?: string | undefined;
  title?: string | undefined;
  open?: boolean;
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
 * @param props.onRemove - removes this annotation from the draft.
 * @returns the rail entry.
 */
export function ResponseAnnotationChip({
  index,
  annotation,
  labels,
  onRemove,
}: {
  index: number;
  annotation: ResponseAnnotationView;
  labels: ResponseAnnotationLabels;
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
