/** One transient, native drag target for the transcript and its current Composer. */
import { useEffect, useRef, useState } from "react";
import type { LexicalEditor } from "lexical";
import { DRAGOVER_COMMAND, DROP_COMMAND } from "lexical";
import { ReferenceIconRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConversationContentProps } from "../contract/slots.ts";
import {
  THREAD_REFERENCE_MIME,
  parseThreadReferenceDrag,
  threadReferenceOf,
  type ThreadReference,
} from "../thread-reference.ts";
import css from "./ThreadReferenceDropTarget.module.css";

export function ThreadReferenceDropTarget({
  container,
  editor,
  useSessions,
  t,
}: {
  container: HTMLDivElement | null;
  editor: LexicalEditor | undefined;
  useSessions: ConversationContentProps["useSessions"];
  t: ConversationContentProps["t"];
}) {
  const byId = useSessions((list) => list.byId);
  const catalog = useRef(byId);
  catalog.current = byId;
  const [reference, setReference] = useState<ThreadReference | null>(null);

  useEffect(() => {
    if (container === null || editor === undefined) return;
    let dragged: ThreadReference | undefined;
    const reset = () => {
      dragged = undefined;
      setReference(null);
    };
    const editable = () => editor.isEditable() && editor.getRootElement() !== null;
    const transferOf = (event: DragEvent) => {
      const transfer = event.dataTransfer;
      return transfer?.types.includes(THREAD_REFERENCE_MIME) && !transfer.types.includes("Files")
        ? transfer
        : null;
    };
    const supported = (candidate: ThreadReference | undefined) => {
      const session = candidate === undefined ? undefined : catalog.current[candidate.threadId];
      return session !== undefined && threadReferenceOf(session) !== undefined;
    };
    const inside = (target: EventTarget | null) => {
      if (!(target instanceof Node) || !container.contains(target)) return false;
      const element = target instanceof Element ? target : target.parentElement;
      return element?.closest("[data-conversation-content]") === container;
    };
    const start = (event: DragEvent) => {
      reset();
      const transfer = transferOf(event);
      const candidate =
        transfer === null
          ? undefined
          : parseThreadReferenceDrag(transfer.getData(THREAD_REFERENCE_MIME));
      if (supported(candidate)) dragged = candidate;
    };
    const over = (event: DragEvent) => {
      const transfer = transferOf(event);
      if (transfer === null || !inside(event.target)) {
        setReference(null);
        return;
      }
      if (!editable() || !supported(dragged)) {
        event.preventDefault();
        event.stopPropagation();
        transfer.dropEffect = "none";
        setReference(null);
        return;
      }
      if (editor.dispatchCommand(DRAGOVER_COMMAND, event)) setReference(dragged ?? null);
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && container.contains(event.relatedTarget)) return;
      const bounds = container.getBoundingClientRect();
      if (
        event.relatedTarget !== null ||
        event.target === container ||
        event.clientX <= bounds.left ||
        event.clientX >= bounds.right ||
        event.clientY <= bounds.top ||
        event.clientY >= bounds.bottom
      )
        setReference(null);
    };
    const drop = (event: DragEvent) => {
      const transfer = transferOf(event);
      if (transfer !== null && inside(event.target)) {
        const candidate = parseThreadReferenceDrag(transfer.getData(THREAD_REFERENCE_MIME));
        if (editable() && supported(candidate) && candidate?.threadId === dragged?.threadId) {
          editor.dispatchCommand(DROP_COMMAND, event);
        } else {
          event.preventDefault();
          event.stopPropagation();
          transfer.dropEffect = "none";
        }
      }
      reset();
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") reset();
    };
    const unregisterEditable = editor.registerEditableListener((value) => {
      if (!value) reset();
    });
    document.addEventListener("dragstart", start);
    document.addEventListener("dragenter", over, true);
    document.addEventListener("dragover", over, true);
    document.addEventListener("dragleave", leave, true);
    document.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", cancel, true);
    return () => {
      unregisterEditable();
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragenter", over, true);
      document.removeEventListener("dragover", over, true);
      document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [container, editor]);

  if (reference === null) return null;
  return (
    <div className={css.overlay} data-thread-reference-drop role="status" aria-live="polite">
      <div className={css.invitation}>
        <div className={css.hint}>{t("reference.dropTitle")}</div>
        <div className={css.preview} data-thread-reference-preview>
          <ReferenceIconRegular kind="session" size={20} />
          <span className={css.title}>{reference.title}</span>
        </div>
      </div>
    </div>
  );
}
