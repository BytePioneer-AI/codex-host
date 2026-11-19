/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "@deepseek-ai/dsh-util-crypto";
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type {
  ISessions,
  PendingSubmissionRetirement,
  SessionFace,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-file-upload/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import { NS } from "./locales.ts";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  ComposerAttachment,
  ComposerFileAttachment,
  ComposerImageAttachment,
  DraftFileUpload,
} from "./contract/slots.ts";
import type { QueueAction } from "@deepseek-ai/dsh-api-session-controller/types";
import type { MessageId } from "@deepseek-ai/dsh-llm/brand";
import type { ComposerBlocks } from "./contract/composer-blocks.ts";
import type {
  DraftAttachmentId,
  DraftAttachmentSerializationResult,
  SessionInputResolver,
  SubmitOutcome,
} from "./contract/input.ts";
import type { InputSubmitMode } from "./contract/composer-submission.ts";
import { preparePhoto } from "./prepare-photo.ts";

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver;
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks;
  /**
   * Send a prompt into the caller scope's session (queued turn).
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>;
  /**
   * Apply one edit, remove, or Steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged QueueDock races resolve, while other failures reject.
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<void>;
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @returns completion; failures reject as in send.
   */
  cancel(): Promise<void>;
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>;
}

/** Create one browser-only image draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerImageAttachment {
  return {
    kind: "image",
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

/**
 * Fill the draft's intrinsic dimensions once the browser parses the image
 * header (a metadata read off the preview URL, not a full decode). Failures
 * and non-browser runtimes leave them absent — consumers size those images
 * from CSS constraints instead. The descriptors stay registry-owned; submit
 * reads the dimensions into an immutable echo snapshot, so this late write
 * does not require a store notification.
 */
function probeDimensions(attachment: ComposerImageAttachment): void {
  if (typeof Image !== "function") return;
  const probe = new Image();
  probe.onload = () => {
    attachment.width = probe.naturalWidth;
    attachment.height = probe.naturalHeight;
  };
  probe.src = attachment.previewUrl;
}

/** Give the echo one paint opportunity without letting a throttled frame clock block admission. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        setTimeout(resolve, 0);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        setTimeout(resolve, 0);
      };
      const fallback = setTimeout(finish, 100);
      requestAnimationFrame(finish);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver;
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks;
  /** Live upload state per image or file draft. */
  readonly fileUploads: SnapshotStore<Record<string, DraftFileUpload>> = createSnapshotStore<
    Record<string, DraftFileUpload>
  >({});
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>();
  private readonly preparedPhotos = new WeakMap<ComposerImageAttachment, Promise<File>>();
  private readonly fileUploadOperations = new Map<
    DraftAttachmentId,
    {
      readonly controller: AbortController;
      readonly done: Promise<void>;
    }
  >();
  private readonly pendingFileUploads = new Set<Promise<void>>();
  private readonly fileUploadQueue: Array<{
    readonly run: () => Promise<void>;
    readonly settle: () => void;
  }> = [];
  private readonly uploadSessions = new Map<DraftAttachmentId, SessionId>();
  private readonly foregroundRetried = new Set<DraftAttachmentId>();
  private activeFileUploads = 0;
  private readonly maxConcurrentFileUploads: number;

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(
    ctx: Context,
    config: {
      input: SessionInputResolver;
      blocks: ComposerBlocks;
      maxConcurrentFileUploads: number;
    },
  ) {
    super(ctx, "conversation");
    this.input = config.input;
    this.blocks = config.blocks;
    this.maxConcurrentFileUploads = config.maxConcurrentFileUploads;
    ctx.effect(() => {
      if (typeof document === "undefined") return;
      const retry = (): void => {
        if (document.visibilityState !== "visible") return;
        for (const [id, sessionId] of this.uploadSessions) {
          const upload = this.fileUploads.getSnapshot()[id];
          if (upload?.status !== "error" || !upload.transport || this.foregroundRetried.has(id))
            continue;
          this.foregroundRetried.add(id);
          this.retryFileUpload(sessionId, id);
        }
      };
      document.addEventListener("visibilitychange", retry);
      return () => document.removeEventListener("visibilitychange", retry);
    }, "conversation foreground upload retry");
    ctx.effect(
      () => async () => {
        const operations = [...this.fileUploadOperations.values()];
        for (const operation of operations) operation.controller.abort();
        await Promise.allSettled([...this.pendingFileUploads]);
        this.fileUploadOperations.clear();
        this.fileUploadQueue.length = 0;
        for (const attachment of this.draftAttachments.values()) {
          if (attachment.kind === "image") revokePreview(attachment.previewUrl);
        }
        this.draftAttachments.clear();
        this.uploadSessions.clear();
        this.foregroundRetried.clear();
        this.fileUploads.set({});
      },
      "conversation draft attachments",
    );
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer state); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession("send");
    const result = await session.prompt([{ type: "text", text }], "queue");
    if (!result.ok)
      throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`);
  }

  /**
   * Submit ordered draft attachments with text through one host admission. A local
   * submission echo enters the session snapshot synchronously; serialization
   * and the prompt round-trip start after the browser can paint it. On the
   * echo's observed retirement seeds admitted image previews into the durable
   * cache and removes every attachment from the draft registry. On failure,
   * every attachment remains registered so the composer can restore it.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const reference =
      attachmentIds.length === 0
        ? undefined
        : this.requireSessions().retain(session.sessionId, {
            source: "controllerOperation",
          });
    try {
      const attachments = this.resolveDraftAttachments(attachmentIds);
      if (attachments.length !== attachmentIds.length) {
        throw new Error(
          "conversation.sendSession: one or more draft attachments are no longer available",
        );
      }
      this.assertUploadsNotFailed(attachmentIds);
      const pendingAttachments = attachments.map((attachment) => ({
        upload: {
          subscribe: this.fileUploads.subscribe,
          getSnapshot: () => this.fileUploads.getSnapshot()[attachment.id],
        },
        ...(attachment.kind === "image"
          ? {
              type: "image" as const,
              value: {
                previewUrl: attachment.previewUrl,
                ...(attachment.file.name === "" ? {} : { name: attachment.file.name }),
                ...(attachment.width === undefined ? {} : { width: attachment.width }),
                ...(attachment.height === undefined ? {} : { height: attachment.height }),
              },
            }
          : {
              type: "file" as const,
              value: {
                attachmentId: attachment.id as Extract<
                  DraftFileUpload,
                  { status: "ready" }
                >["file"]["attachmentId"],
                name: attachment.file.name,
                bytes: attachment.file.size,
              },
            }),
      }));
      const serializeAttachments = async (): Promise<Parameters<SessionFace["prompt"]>[0]> =>
        (await this.serializeDraftAttachments(attachmentIds)).attachments;
      const snapshot = session.getSnapshot();
      if (snapshot.subagent !== null) {
        const uploaded = await serializeAttachments();
        const content = [...uploaded, ...(text === "" ? [] : [{ type: "text" as const, text }])];
        const result = await session.prompt(content, mode, signal);
        return result.ok ? { kind: "success" } : { kind: "error" };
      }
      let finishRetirement: ((retirement: PendingSubmissionRetirement) => void) | undefined;
      const retirement =
        attachments.length === 0
          ? undefined
          : new Promise<PendingSubmissionRetirement>((resolve) => {
              finishRetirement = resolve;
            });
      const submission = session.beginSubmission({
        mode,
        text,
        attachments: pendingAttachments,
        onRetire: (settlement) => {
          this.settleSubmittedAttachments(session.sessionId, attachments, settlement);
          finishRetirement?.(settlement);
        },
      });
      let content: Parameters<SessionFace["prompt"]>[0];
      try {
        await nextPaint();
        const uploaded = await serializeAttachments();
        content = [...uploaded, ...(text === "" ? [] : [{ type: "text" as const, text }])];
      } catch (error) {
        submission.abandon();
        throw error;
      }
      const result = await session.prompt(content, mode, signal, submission.requestId);
      if (!result.ok) return { kind: "error" };
      if (retirement !== undefined && (await retirement).reason !== "observed")
        return { kind: "error" };
      return { kind: "success" };
    } finally {
      reference?.release();
    }
  }

  /**
   * Create runtime-only draft attachments. Files whose browser MIME is an
   * accepted image type become image drafts with object URL previews;
   * every attachment starts uploading immediately and remains owned across Session
   * navigation until completion or explicit removal.
   * @param sessionId - target Agent-scope identity.
   * @param files - browser files to register.
   * @returns ordered draft descriptors.
   */
  createDrafts(sessionId: SessionId, files: readonly File[]): readonly ComposerAttachment[] {
    return files.map((file) => {
      if (isImageMediaType(file.type)) {
        const attachment = browserDraftAttachment(file);
        this.draftAttachments.set(attachment.id, attachment);
        probeDimensions(attachment);
        this.beginFileUpload(sessionId, attachment);
        return attachment;
      }
      const attachment: ComposerFileAttachment = {
        kind: "file",
        id: randomUUID() as DraftAttachmentId,
        file,
      };
      this.draftAttachments.set(attachment.id, attachment);
      this.beginFileUpload(sessionId, attachment);
      return attachment;
    });
  }

  /**
   * Restart one failed file upload.
   * @param sessionId - target Agent-scope identity.
   * @param id - draft attachment id whose upload previously failed.
   */
  retryFileUpload(sessionId: SessionId, id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id);
    if (attachment === undefined) return;
    if (this.fileUploads.getSnapshot()[id]?.status !== "error") return;
    this.beginFileUpload(sessionId, attachment);
  }

  /**
   * Stage carried file drafts again for a new Session.
   * @param sessionId - target Agent-scope identity after a Workspace switch.
   * @param ids - carried draft attachment ids.
   */
  rebindDraftFiles(sessionId: SessionId, ids: readonly DraftAttachmentId[]): void {
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id);
      if (attachment !== undefined) this.beginFileUpload(sessionId, attachment);
    }
  }

  private beginFileUpload(sessionId: SessionId, attachment: ComposerAttachment): void {
    this.uploadSessions.set(attachment.id, sessionId);
    this.fileUploadOperations.get(attachment.id)?.controller.abort();
    const controller = new AbortController();
    this.fileUploads.update((draft) => {
      draft[attachment.id] = { status: "uploading", loaded: 0, total: attachment.file.size };
    });
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.fileUploadOperations.set(attachment.id, { controller, done });
    this.pendingFileUploads.add(done);
    void done.then(() => {
      this.pendingFileUploads.delete(done);
    });
    const run = async (): Promise<void> => {
      try {
        if (
          controller.signal.aborted ||
          this.fileUploadOperations.get(attachment.id)?.controller !== controller
        )
          return;
        let file = attachment.file;
        if (
          attachment.kind === "image" &&
          (file.type === "image/jpeg" || file.type === "image/webp")
        ) {
          let prepared = this.preparedPhotos.get(attachment);
          if (prepared === undefined) {
            prepared = preparePhoto(file);
            this.preparedPhotos.set(attachment, prepared);
          }
          file = await prepared;
          if (
            controller.signal.aborted ||
            this.fileUploadOperations.get(attachment.id)?.controller !== controller
          )
            return;
          this.fileUploads.update((draft) => {
            draft[attachment.id] = { status: "uploading", loaded: 0, total: file.size };
          });
        }
        const result = await this.ctx.fileUpload.upload(
          sessionId,
          file,
          file.name === "" ? undefined : file.name,
          controller.signal,
          (progress) => {
            if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
            this.fileUploads.update((draft) => {
              if (!(attachment.id in draft)) return;
              draft[attachment.id] = {
                status: "uploading",
                loaded: progress.loaded,
                ...(progress.total === undefined ? {} : { total: progress.total }),
              };
            });
          },
          attachment.kind === "image" ? file.type : undefined,
        );
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return;
          draft[attachment.id] = result.ok
            ? { status: "ready", receiptId: result.value.receiptId, file: result.value.file }
            : { status: "error", message: result.error.message, transport: false };
        });
      } catch (error) {
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return;
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return;
          draft[attachment.id] = {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
            transport: true,
          };
        });
      } finally {
        if (this.fileUploadOperations.get(attachment.id)?.controller === controller) {
          this.fileUploadOperations.delete(attachment.id);
        }
      }
    };
    this.fileUploadQueue.push({ run, settle });
    this.pumpFileUploads();
  }

  /** Start queued upload Workers until the configured concurrency is occupied. */
  private pumpFileUploads(): void {
    while (this.activeFileUploads < this.maxConcurrentFileUploads) {
      const task = this.fileUploadQueue.shift();
      if (task === undefined) return;
      this.activeFileUploads += 1;
      void task.run().finally(() => {
        this.activeFileUploads -= 1;
        task.settle();
        this.pumpFileUploads();
      });
    }
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft attachments.
   * @param ids - draft attachment ids.
   * @returns descriptors that remain live, in requested order.
   */
  resolveDraftAttachments(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = [];
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id);
      if (attachment !== undefined) attachments.push(attachment);
    }
    return attachments;
  }

  /**
   * Serialize ordered draft attachments to command-submit wire payloads without
   * sending or releasing them. Images and files cite receipts from their
   * completed background uploads and never reread browser bytes.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @returns wire payloads in id order.
   */
  async serializeDraftAttachments(
    attachmentIds: readonly DraftAttachmentId[],
  ): Promise<DraftAttachmentSerializationResult> {
    const attachments = this.resolveDraftAttachments(attachmentIds);
    if (attachments.length !== attachmentIds.length) {
      throw new Error(
        "conversation.serializeDraftAttachments: one or more draft attachments are no longer available",
      );
    }
    await this.waitForUploads(attachmentIds);
    const uploads = this.fileUploads.getSnapshot();
    return {
      attachments: attachments.map((attachment) => ({
        type: "file" as const,
        receiptId: (uploads[attachment.id] as Extract<DraftFileUpload, { status: "ready" }>)
          .receiptId,
      })),
    };
  }

  /**
   * Release one browser-owned draft attachment, aborting its active upload.
   * @param id - draft attachment id.
   */
  releaseDraftAttachment(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id);
    if (attachment === undefined) return;
    const operation = this.fileUploadOperations.get(id);
    this.fileUploadOperations.delete(id);
    operation?.controller.abort();
    this.draftAttachments.delete(id);
    this.uploadSessions.delete(id);
    this.foregroundRetried.delete(id);
    if (attachment.kind === "image") revokePreview(attachment.previewUrl);
    // The stored Host object stays durable; only the draft's upload state ends.
    this.fileUploads.set(
      Object.fromEntries(
        Object.entries(this.fileUploads.getSnapshot()).filter(([key]) => key !== id),
      ),
    );
  }

  /**
   * Release a set of browser-owned draft attachments.
   * @param attachments - descriptors to release.
   */
  releaseDraftAttachments(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id);
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<void> {
    const session = this.scopedSession("updateQueue");
    const result = await session.updateQueue(itemId, action);
    if (!result.ok) {
      if (
        action.kind === "steer" &&
        (result.error.code === "session/steer-unavailable" ||
          result.error.code === "session/queue-item-not-found")
      )
        return;
      throw new Error(
        `conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`,
      );
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(): Promise<void> {
    const session = this.scopedSession("cancel");
    const result = await session.cancel();
    if (!result.ok)
      throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`);
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession("loadOlder").loadOlder();
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op);
    const binding = this.requireSessions().binding(id);
    if (binding === undefined)
      throw new Error(`conversation.${op}: session "${id}" resolved no binding`);
    return binding.session;
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx);
    if (id === undefined) {
      throw new Error(
        `conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`,
      );
    }
    return id;
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get("sessions");
    if (sessions === undefined) throw new Error("conversation: sessions service unavailable");
    return sessions;
  }

  /**
   * Settle one submission's draft attachments when its echo retires. Observed:
   * each image leaves the registry, handing its preview URL to the durable
   * image cache (seeded under the admitted reference so the transcript node
   * renders immediately while the cache reads canonical bytes) or revoking it
   * when the cache already holds that reference. Failed: nothing changes;
   * the ids stay registered for the composer's rail restore.
   */
  private settleSubmittedAttachments(
    sessionId: SessionId,
    attachments: readonly ComposerAttachment[],
    retirement: PendingSubmissionRetirement,
  ): void {
    if (retirement.reason !== "observed") return;
    const uiConversation = this.ctx.get("uiConversation");
    let observedIndex = 0;
    for (const attachment of attachments) {
      const live = this.draftAttachments.get(attachment.id);
      const ref = retirement.attachments[observedIndex++];
      if (live === undefined) continue;
      if (attachment.kind === "file") {
        this.releaseDraftAttachment(attachment.id);
        continue;
      }
      this.uploadSessions.delete(attachment.id);
      this.foregroundRetried.delete(attachment.id);
      this.fileUploads.update((draft) => {
        delete draft[attachment.id];
      });
      this.draftAttachments.delete(attachment.id);
      if (
        ref !== undefined &&
        "mediaType" in ref &&
        uiConversation?.seedImageUrl(sessionId, ref, attachment.previewUrl) === true
      )
        continue;
      revokePreview(attachment.previewUrl);
    }
  }

  private assertUploadsNotFailed(ids: readonly DraftAttachmentId[]): void {
    if (ids.some((id) => this.fileUploads.getSnapshot()[id]?.status === "error"))
      throw new Error(this.ctx.locale.bind(NS)("file.retryOrRemove"));
  }

  /** Observe just this submission's uploads, independent of the visible Session. */
  private waitForUploads(ids: readonly DraftAttachmentId[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const uploads = this.fileUploads.getSnapshot();
        if (ids.some((id) => uploads[id] === undefined || uploads[id]?.status === "error")) {
          off();
          reject(new Error(this.ctx.locale.bind(NS)("file.retryOrRemove")));
        } else if (ids.every((id) => uploads[id]?.status === "ready")) {
          off();
          resolve();
        }
      };
      const off = this.fileUploads.subscribe(check);
      check();
    });
  }
}

/**
 * Whether a browser-declared MIME selects the image draft path (all other files upload verbatim).
 * @param value - the browser's declared MIME type.
 * @returns whether the file is an accepted raster image.
 */
export function isImageMediaType(value: string): boolean {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function revokePreview(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
