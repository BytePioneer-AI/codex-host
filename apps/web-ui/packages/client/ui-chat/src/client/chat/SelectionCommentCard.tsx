/**
 * The comment card that opens beside a selected passage: the passage as a
 * one-line excerpt and a field for the user's note. Enter attaches, Shift+Enter
 * breaks the line, Escape and any outside press close it.
 *
 * The card only collects text. Where it sits, whether the selection is still
 * valid, and how the note joins the draft belong to {@link SelectionActions}.
 */
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import css from "./SelectionCommentCard.module.css";

/** The card's drawn height in px (excerpt, two-row field, button), used to place it before it is measured. */
export const COMMENT_CARD_HEIGHT = 124;

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
 * @param props.excerpt - the selected text, shown folded to one line.
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
  const comment = value.trim();

  useEffect(() => {
    // The card is placed from the selection's rect; letting focus scroll the
    // page would move the passage away from it.
    fieldRef.current?.focus({ preventScroll: true });
  }, [fieldRef]);

  const submit = (): void => {
    if (comment !== "" && !onSubmit(comment)) setUnavailable(true);
  };

  return (
    <div
      className={css.card}
      data-placement={below ? "below" : "above"}
      style={style}
      data-selection-actions
      onKeyDown={(event) => {
        // Escape closes from any control in the card, but while an IME is
        // composing it belongs to the composition.
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onCancel();
        }
      }}
      onMouseDown={(event) => {
        // Pressing the card's padding or its button must not take focus from the
        // field; only the field itself may place the caret.
        if (event.target !== fieldRef.current) event.preventDefault();
      }}
    >
      <div className={css.excerpt}>{excerpt.replace(/\s+/gu, " ")}</div>
      <textarea
        ref={fieldRef}
        className={css.field}
        rows={2}
        value={value}
        placeholder={labels.placeholder}
        aria-label={labels.placeholder}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          // An Enter that confirms an IME candidate must not attach the note.
          // oxlint-disable-next-line typescript/no-deprecated -- keyCode 229 covers engines without isComposing.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {unavailable && (
        <div role="alert" className={css.error}>
          {labels.unavailable}
        </div>
      )}
      <div className={css.actions}>
        <button type="button" className={css.cancel} onClick={onCancel}>
          {labels.cancel}
        </button>
        <button type="button" className={css.submit} disabled={comment === ""} onClick={submit}>
          {labels.submit}
        </button>
      </div>
    </div>
  );
}
