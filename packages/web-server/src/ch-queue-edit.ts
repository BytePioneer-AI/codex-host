/** Queued message projection cache and atomic take-for-edit orchestration over Shared Host queues. */
import { createHash } from "node:crypto";
import type { ClientThreadSnapshot } from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChFileInputs } from "./ch-file-inputs.ts";
import { editableQueuedInput } from "./native-user-input.ts";
import { RpcError } from "./transport.ts";
import type { WebFiles, WebFileRef } from "./web-files.ts";
import { WEB_IMAGE_LIMITS, type WebImages } from "./web-images.ts";

export interface RestoredQueuedAttachment {
  readonly kind: "image" | "file";
  readonly receiptId: string;
  readonly file: WebFileRef;
}

export interface RestoredQueuedMessage {
  readonly text: string;
  readonly attachments: readonly RestoredQueuedAttachment[];
}

export type QueueEditEvaluator = (
  input: readonly unknown[],
  projected: readonly unknown[],
  allowsAttachments: boolean,
) => boolean;

interface CachedQueueEntry {
  readonly revision: string;
  readonly allowsAttachments: boolean;
  readonly readOnly: boolean;
  readonly content: unknown[];
  readonly editable: boolean;
}

type SnapshotQueueItem = NonNullable<ClientThreadSnapshot["queue"]>["items"][number];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeQueueInput(input: readonly unknown[]): unknown[] {
  return input.map((part) => {
    if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      const record = part as Record<string, unknown>;
      // Match Host `nativeQueuedSubmission` normalization so snapshot and list revisions agree.
      if (record.type === "text" && record.text_elements === undefined) {
        return { ...record, text_elements: [] };
      }
    }
    return part;
  });
}

function hasPlaceholderImage(projected: readonly unknown[]): boolean {
  for (const part of projected) {
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: unknown;
      attachment?: { fingerprint?: unknown; bytes?: unknown };
    };
    if (
      block.type === "image" &&
      (typeof block.attachment?.fingerprint !== "string" ||
        typeof block.attachment.bytes !== "number" ||
        block.attachment.bytes <= 0)
    ) {
      return true;
    }
  }
  return false;
}

/** Stable fingerprint of one queued submission's canonical Host input. */
export function queueInputRevision(input: readonly unknown[]): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeQueueInput(input)))
    .digest("hex");
}

/** Decide whether a canonical queued input can be safely restored into the Web composer. */
export function canEditQueuedInput(
  input: readonly unknown[],
  projected: readonly unknown[],
  allowsAttachments: boolean,
  storage?: { readonly images?: WebImages; readonly files?: WebFiles },
): boolean {
  const parsed = editableQueuedInput(input);
  if (!parsed) return false;
  if (parsed.attachments.length === 0) return true;
  if (!allowsAttachments || !storage?.images || !storage.files) return false;

  const projectedImages = new Map<string, number>();
  for (const part of projected) {
    if (!part || typeof part !== "object") continue;
    const block = part as {
      type?: unknown;
      attachment?: { attachmentId?: unknown; bytes?: unknown };
    };
    if (
      block.type === "image" &&
      typeof block.attachment?.attachmentId === "string" &&
      typeof block.attachment.bytes === "number"
    ) {
      projectedImages.set(block.attachment.attachmentId, block.attachment.bytes);
    }
  }

  let imageCount = 0;
  let imageBytes = 0;
  for (const attachment of parsed.attachments) {
    if (attachment.kind === "image") {
      const imageId = storage.images.idForPath(attachment.path);
      if (!imageId) return false;
      imageCount += 1;
      if (imageCount > WEB_IMAGE_LIMITS.maxImagesPerMessage) return false;
      const bytes = projectedImages.get(imageId);
      if (bytes === undefined || !Number.isSafeInteger(bytes) || bytes <= 0) return false;
      imageBytes += bytes;
      if (imageBytes > WEB_IMAGE_LIMITS.maxMessageImageBytes) return false;
      continue;
    }
    if (!storage.files.reference(attachment.path)) return false;
  }
  return true;
}

/** Cache projected queue rows and editability per item id + input revision across fast refreshes. */
export class ChQueueProjectionCache {
  private readonly entries = new Map<string, CachedQueueEntry>();

  project(
    items: readonly SnapshotQueueItem[],
    options: {
      readonly projectInput?: (content: unknown[]) => unknown[];
      readonly canEdit?: QueueEditEvaluator;
      readonly allowsAttachments: boolean;
      readonly readOnly: boolean;
    },
  ): {
    readonly nextTurn: Array<{
      readonly id: string;
      readonly role: "user";
      readonly content: unknown[];
      readonly source: { readonly kind: "user"; readonly rpcId: string };
    }>;
    readonly editable: Record<string, string>;
  } {
    const activeIds = new Set<string>();
    const nextTurn: Array<{
      readonly id: string;
      readonly role: "user";
      readonly content: unknown[];
      readonly source: { readonly kind: "user"; readonly rpcId: string };
    }> = [];
    const editable: Record<string, string> = {};

    for (const item of items) {
      activeIds.add(item.id);
      const revision = queueInputRevision(item.input);
      let cached = this.entries.get(item.id);
      if (
        !cached ||
        cached.revision !== revision ||
        cached.allowsAttachments !== options.allowsAttachments ||
        cached.readOnly !== options.readOnly
      ) {
        const content = options.projectInput
          ? options.projectInput(item.input)
          : (item.presentationInput ?? item.input);
        const canEdit =
          !options.readOnly &&
          (options.canEdit
            ? options.canEdit(item.input, content, options.allowsAttachments)
            : false);
        cached = {
          revision,
          allowsAttachments: options.allowsAttachments,
          readOnly: options.readOnly,
          content,
          editable: canEdit,
        };
        if (hasPlaceholderImage(content)) this.entries.delete(item.id);
        else this.entries.set(item.id, cached);
      }
      nextTurn.push({
        id: item.id,
        role: "user",
        content: cached.content,
        source: { kind: "user", rpcId: item.clientUserMessageId },
      });
      if (cached.editable) editable[item.id] = cached.revision;
    }

    for (const id of this.entries.keys()) {
      if (!activeIds.has(id)) this.entries.delete(id);
    }

    return { nextTurn, editable };
  }
}

/**
 * Verify revision and Web-attachment ownership, stage fresh receipts, remove the queued item from
 * the Shared Host, and return composer-restorable text and attachments. Rolls back staged receipts
 * if removal fails or confirms the item was already taken.
 */
export async function takeQueuedItemForEdit(input: {
  readonly host: ChHostClient;
  readonly threadId: string;
  readonly itemId: string;
  readonly revision: string;
  readonly allowsAttachments: boolean;
  readonly fileInputs?: ChFileInputs;
  readonly refreshView: () => Promise<void>;
  readonly invalidateView: () => void;
}): Promise<RestoredQueuedMessage> {
  const { host, threadId, itemId, revision, allowsAttachments, fileInputs } = input;
  const page = await host.request<{ data?: unknown }>("thread/queue/list", {
    threadId,
    limit: 100,
  });
  const rows = Array.isArray(page?.data) ? page.data : [];
  const target = rows.find(
    (entry): entry is { id: string; input: unknown[] } =>
      Boolean(entry) &&
      typeof entry === "object" &&
      (entry as { id?: unknown }).id === itemId &&
      Array.isArray((entry as { input?: unknown }).input),
  );
  if (!target)
    throw new RpcError("session/queue-item-not-found", "Queued message is no longer pending.");
  if (queueInputRevision(target.input) !== revision)
    throw new RpcError("session/queue-item-changed", "Queued message changed before editing.");

  const parsed = editableQueuedInput(target.input);
  if (!parsed)
    throw new RpcError(
      "session/queue-edit-unsupported",
      "Queued message contains content that cannot be edited safely.",
    );

  let staged: RestoredQueuedAttachment[] = [];
  if (parsed.attachments.length > 0) {
    if (!allowsAttachments || !fileInputs)
      throw new RpcError(
        "session/queue-edit-unsupported",
        "Queued attachments cannot be edited in this session.",
      );
    staged = (await fileInputs.stageStored(threadId, parsed.attachments)).map(
      ({ kind, receiptId, file }) => ({ kind, receiptId, file }),
    );
  }

  const receiptIds = staged.map((entry) => entry.receiptId);
  try {
    const result = await host.request<{ deleted?: boolean }>("thread/queue/delete", {
      threadId,
      queuedSubmissionId: itemId,
    });
    if (!result?.deleted)
      throw new RpcError("session/queue-item-not-found", "Queued message is no longer pending.");
  } catch (error) {
    fileInputs?.discard(threadId, receiptIds);
    throw error;
  }

  try {
    await input.refreshView();
  } catch {
    // Removal was confirmed by the Host. A failed projection read must not prevent
    // restoring the removed message and its staged attachments into the local composer.
    input.invalidateView();
  }

  return { text: parsed.text, attachments: staged };
}
