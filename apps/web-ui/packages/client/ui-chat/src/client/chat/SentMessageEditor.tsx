import { useRef, useState } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewInjected, ChatViewSlotProps, SentMessageEditing } from "../contract/slots.ts";
import css from "./MessageItem.module.css";

/** The edit draft lives above transcript nodes so a Host history replacement cannot erase it. */
export function useSentMessageEditing(
  send: ChatViewInjected["editMessage"],
  targetSeq: number | null,
  unavailable: boolean,
): SentMessageEditing {
  const [draft, setDraft] = useState<SentMessageEditing["draft"]>(null);
  const pending = useRef(false);
  return {
    targetSeq: send && !unavailable ? targetSeq : null,
    draft,
    begin(seq, text, content) {
      if (pending.current || unavailable || seq !== targetSeq) return;
      setDraft({ seq, text, content, pending: false, blocked: false });
    },
    change(text) {
      setDraft((d) => (d && !d.pending ? { ...d, text } : d));
    },
    cancel() {
      if (!pending.current) setDraft(null);
    },
    send() {
      if (!send || !draft || draft.blocked || pending.current || unavailable || !draft.text.trim())
        return;
      pending.current = true;
      setDraft({ ...draft, pending: true, error: undefined });
      void send(draft.seq, draft.text)
        .then(
          (receipt) => {
            if (receipt.status === "accepted") setDraft(null);
            else
              setDraft({
                ...draft,
                pending: false,
                blocked: receipt.status !== "rejected",
                error: receipt.message,
              });
          },
          (error: unknown) => {
            setDraft({
              ...draft,
              pending: false,
              blocked: true,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        )
        .finally(() => {
          pending.current = false;
        });
    },
  };
}

/** Inline editor leaves the ordinary composer and its attachment rail untouched. */
export function SentMessageEditor({
  editing,
  t,
}: {
  editing: SentMessageEditing;
  t: ChatViewSlotProps["t"];
}) {
  const draft = editing.draft;
  if (!draft) return null;
  return (
    <form
      className={css.sentEditor}
      data-sent-message-editor
      onSubmit={(event) => {
        event.preventDefault();
        editing.send();
      }}
    >
      <textarea
        autoFocus
        aria-label={t("message.edit")}
        value={draft.text}
        disabled={draft.pending}
        onChange={(event) => editing.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            editing.send();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            editing.cancel();
          }
        }}
      />
      {!draft.pending && !draft.error && editing.targetSeq !== draft.seq && (
        <div role="status">{t("message.edit.changed")}</div>
      )}
      {draft.error && (
        <div role="alert">
          {draft.error}
          {draft.blocked ? ` ${t("message.edit.checkHistory")}` : ""}
        </div>
      )}
      <div className={css.sentEditorActions}>
        <Button variant="outline" size="sm" disabled={draft.pending} onClick={editing.cancel}>
          {t("message.edit.cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          disabled={
            draft.pending || draft.blocked || !draft.text.trim() || editing.targetSeq !== draft.seq
          }
        >
          {draft.pending ? t("message.edit.sending") : t("message.edit.send")}
        </Button>
      </div>
    </form>
  );
}
