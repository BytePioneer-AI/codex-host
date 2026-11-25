/**
 * The comment card that opens beside a selected passage: the passage as a
 * quoted excerpt and a borderless note field beside a monochrome submit pill.
 * Enter attaches, Shift+Enter breaks the line, Escape and outside presses close it.
 *
 * The card only collects text. Where it sits, whether the selection is still
 * valid, and how the note joins the draft belong to {@link SelectionActions}.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { observeComposition } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./SelectionCommentCard.module.css";

/** Approximate drawn height in px (excerpt + single-row input), used before measurement. */
export const COMMENT_CARD_HEIGHT = 104;
const FIELD_MAX_HEIGHT = 116;

function supportsFieldSizingContent(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("field-sizing", "content")
  );
}

/** Owner-provided copy for the card. */
export interface SelectionCommentLabels {
  /** Accessible name and placeholder of the note field. */
  readonly placeholder: string;
  /** Button label: attach the passage together with the note. */
  readonly submit: string;
  /** Button label: close the note field without attaching it. */
  readonly cancel: string;
  /** Feedback shown when the draft can no longer be attached. */
  readonly unavailable: string;
}

/**
 * Collect one note for a selected passage.
 * @param props.excerpt - the selected text, shown as a compact quote.
 * @param props.labels - localized copy.
 * @param props.fieldRef - lets the owner preserve the draft on background scroll.
 * @param props.style - fixed-position anchor resolved by the caller.
 * @param props.below - whether the card is drawn below the selection.
 * @param props.onSubmit - attaches the passage with the trimmed note; false keeps the card open.
 * @param props.onCancel - closes the card without attaching.
 * @returns the card.
 */
export function SelectionCommentCard({
  excerpt,
  labels,
  fieldRef,
  style,
  below,
  onSubmit,
  onCancel,
}: {
  excerpt: string;
  labels: SelectionCommentLabels;
  fieldRef: RefObject<HTMLTextAreaElement>;
  style: CSSProperties;
  below: boolean;
  onSubmit: (comment: string) => boolean;
  onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const compositionRef = useRef<ReturnType<typeof observeComposition> | null>(null);
  const comment = value.trim();

  useEffect(() => {
    // The card is placed from the selection's rect; letting focus scroll the
    // page would move the passage away from it.
    fieldRef.current?.focus({ preventScroll: true });
    const observer = observeComposition(document);
    compositionRef.current = observer;
    return () => {
      observer.dispose();
      if (compositionRef.current === observer) compositionRef.current = null;
    };
  }, [fieldRef]);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field === null || supportsFieldSizingContent()) return;
    field.style.height = "auto";
    field.style.height = `${String(Math.min(field.scrollHeight, FIELD_MAX_HEIGHT))}px`;
  }, [fieldRef, value]);

  const submit = (): void => {
    if (comment !== "" && !onSubmit(comment)) setUnavailable(true);
  };

  return (
    <div
      className={css.card}
      role="dialog"
      aria-label={labels.placeholder}
      data-placement={below ? "below" : "above"}
      style={style}
      data-selection-actions
      onKeyDown={(event) => {
        // Escape closes from any control in the card, but while an IME is
        // composing it belongs to the composition.
        if (event.key !== "Escape") return;
        if (compositionRef.current?.guards(event.nativeEvent) === true) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      onMouseDown={(event) => {
        // Pressing the card's padding or its button must not take focus from the
        // field; only the field itself may place the caret.
        if (event.target !== fieldRef.current) event.preventDefault();
      }}
    >
      <div className={css.header}>
        <blockquote className={css.excerpt}>{excerpt.replace(/\s+/gu, " ")}</blockquote>
        <button
          type="button"
          className={css.close}
          aria-label={labels.cancel}
          title={labels.cancel}
          onClick={onCancel}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <div className={css.inputRow}>
        <textarea
          ref={fieldRef}
          className={css.field}
          rows={1}
          value={value}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // An Enter that confirms an IME candidate must not attach the note.
            if (compositionRef.current?.guards(event.nativeEvent) === true) return;
            event.preventDefault();
            submit();
          }}
        />
        <button type="button" className={css.submit} disabled={comment === ""} onClick={submit}>
          <span>{labels.submit}</span>
          <kbd className={css.kbd} aria-hidden="true">
            ↵
          </kbd>
        </button>
      </div>
      {unavailable && (
        <div role="alert" className={css.error}>
          {labels.unavailable}
        </div>
      )}
    </div>
  );
}
