/** Prefetch queued image bytes and restore a removed queued message into the local composer draft. */
import { splitAnnotatedMessage } from "@codexhost/shared-contracts";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { RestoredQueuedMessage } from "../contract/slots.ts";
import type { SessionInputShell } from "../input/facade.ts";
import type { ConversationController } from "../service.ts";

/** Prefetched bytes and projected media type for one queued image attachment. */
export interface PrefetchedQueueImage {
  readonly blob: Blob;
  readonly mediaType: string;
}

/**
 * Fetch image bytes while the queued entry is still authorized in the Host queue so any read
 * failure aborts before the destructive delete RPC runs.
 */
export async function prefetchQueueImageBlobs(
  images: readonly ImageAttachmentRef[],
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>,
): Promise<Map<string, PrefetchedQueueImage>> {
  const unique = new Map<string, ImageAttachmentRef>();
  for (const image of images) {
    if (!unique.has(image.attachmentId)) unique.set(image.attachmentId, image);
  }
  const blobs = new Map<string, PrefetchedQueueImage>();
  await Promise.all(
    [...unique.entries()].map(async ([attachmentId, attachment]) => {
      const url = await loadImage(attachment);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Queued image preview fetch failed (${response.status})`);
      blobs.set(attachmentId, {
        blob: await response.blob(),
        mediaType: attachment.mediaType,
      });
    }),
  );
  return blobs;
}

/**
 * Split any leading response-annotation block out of a queued message's text
 * and restore its annotations (with remembered DOM anchors when available) plus
 * clean request body into the composer without clobbering existing draft input.
 */
export function restoreQueuedTextAndAnnotations(
  shell: SessionInputShell,
  rawText: string,
  rpcId?: string,
): void {
  const { annotations, body } = splitAnnotatedMessage(rawText);
  if (annotations.length > 0) {
    shell.addResponseAnnotations(shell.takeSubmittedAnnotationAnchors(rpcId, annotations));
  }
  if (body !== "") {
    // Preserve text, references and attachments typed while removal was pending.
    const draft = shell.draftSnapshot;
    shell.setDraft({
      ...draft,
      text: draft.text === "" ? body : `${draft.text}\n${body}`,
    });
  }
}

/**
 * Restore removed queued text and staged Web attachments into the originating shell in one
 * synchronous tick once the composer is editable (not in a slash-command adjudication/submission
 * lock), preserving any draft typed in the meantime.
 */
export function restoreQueuedMessageToComposer(input: {
  readonly sessionId: SessionId;
  readonly shell: SessionInputShell;
  readonly conversation?: ConversationController | undefined;
  readonly message: RestoredQueuedMessage;
  readonly imageBlobs: ReadonlyMap<string, PrefetchedQueueImage>;
  readonly rpcId?: string;
}): Promise<void> {
  const { sessionId, shell, conversation, message, imageBlobs, rpcId } = input;
  const applyRestore = (): boolean => {
    if (shell.isDisposed) {
      throw new Error(
        "Queued message was removed, but the session composer was closed before restoring.",
      );
    }
    const { phase } = shell.snapshot;
    if (phase !== "plain" && phase !== "claimed") return false;

    if (message.attachments.length > 0) {
      if (conversation === undefined) {
        throw new Error("Queued attachments cannot be restored without a conversation controller.");
      }
      const staged = message.attachments.map((entry) => {
        if (entry.kind !== "image") return entry;
        const prefetched = imageBlobs.get(entry.file.attachmentId);
        if (prefetched === undefined) return entry;
        const imageFile = new File([prefetched.blob], entry.file.name, {
          type: prefetched.blob.type || prefetched.mediaType || "image/png",
        });
        return { ...entry, imageFile };
      });
      const drafts = conversation.restoreStagedDrafts(sessionId, staged);
      if (!shell.addAttachments(drafts.map((draft) => draft.id))) {
        conversation.releaseDraftAttachments(drafts);
        if (shell.isDisposed) {
          throw new Error(
            "Queued message was removed, but the session composer was closed before restoring.",
          );
        }
        return false;
      }
    }

    if (message.text !== "") {
      restoreQueuedTextAndAnnotations(shell, message.text, rpcId);
    }
    shell.actions.persistDraft();
    shell.focus("end");
    return true;
  };

  try {
    if (applyRestore()) return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let applying = false;
    let unsubscribe: (() => void) | undefined;
    const check = (): void => {
      if (settled || applying) return;
      applying = true;
      try {
        if (!applyRestore()) return;
        settled = true;
        unsubscribe?.();
        resolve();
      } catch (error) {
        settled = true;
        unsubscribe?.();
        reject(error);
      } finally {
        applying = false;
      }
    };
    unsubscribe = shell.state.subscribe(check);
    check();
  });
}
