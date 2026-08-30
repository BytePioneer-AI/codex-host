import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostThreadId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

export const RENDERER_REASONING_NOTIFICATION_METHODS = [
  "item/started",
  "item/reasoning/summaryTextDelta",
  "item/completed",
] as const;

export type RendererReasoningPhase = "live" | "completed";

export interface RendererReasoningEvent {
  readonly kind: "started" | "delta" | "completed";
  readonly threadId: HostThreadId;
  readonly turnId: HostTurnId;
  readonly itemId: string;
  readonly text: string;
}

export interface RendererReasoningSnapshot {
  readonly threadId: HostThreadId;
  readonly turnId: HostTurnId;
  readonly itemId: string;
  readonly phase: RendererReasoningPhase;
  readonly text: string;
}

export interface RendererReasoningPanelView {
  readonly visible: boolean;
  readonly expanded: boolean;
  readonly phase: RendererReasoningPhase;
  readonly text: string;
}

const DEFAULT_PENDING_REASONING_TEXT_LIMIT = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function notificationIdentity(params: Record<string, unknown>): {
  threadId: HostThreadId;
  turnId: HostTurnId;
} | null {
  const threadId = hostThreadIdSchema.safeParse(params.threadId);
  const turnId = hostTurnIdSchema.safeParse(params.turnId);
  return threadId.success && turnId.success
    ? { threadId: threadId.data, turnId: turnId.data }
    : null;
}

export function decodeRendererReasoningNotification(
  notification: unknown,
): RendererReasoningEvent | null {
  if (!isRecord(notification) || !isRecord(notification.params)) return null;
  const params = notification.params;
  const identity = notificationIdentity(params);
  if (!identity) return null;

  if (notification.method === "item/reasoning/summaryTextDelta") {
    const itemId = nonEmptyString(params.itemId);
    if (
      !itemId ||
      typeof params.delta !== "string" ||
      !Number.isInteger(params.summaryIndex) ||
      Number(params.summaryIndex) < 0
    ) {
      return null;
    }
    return { kind: "delta", ...identity, itemId, text: params.delta };
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return null;
  }
  const item = params.item;
  if (!isRecord(item) || item.type !== "reasoning") return null;
  const itemId = nonEmptyString(item.id);
  if (!itemId) return null;
  const summary = item.summary;
  if (!Array.isArray(summary) || !summary.every((part) => typeof part === "string")) return null;
  return {
    kind: notification.method === "item/started" ? "started" : "completed",
    ...identity,
    itemId,
    text: summary.join("\n\n"),
  };
}

export class RendererReasoningStore {
  readonly #byThread = new Map<HostThreadId, RendererReasoningSnapshot>();

  apply(event: RendererReasoningEvent): RendererReasoningSnapshot {
    const current = this.#byThread.get(event.threadId);
    const sameItem = current?.itemId === event.itemId && current.turnId === event.turnId;
    const text =
      event.kind === "delta" ? `${sameItem ? current.text : ""}${event.text}` : event.text;
    const snapshot: RendererReasoningSnapshot = Object.freeze({
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      phase: event.kind === "completed" ? "completed" : "live",
      text,
    });
    this.#byThread.set(event.threadId, snapshot);
    return snapshot;
  }

  snapshot(threadId: HostThreadId): RendererReasoningSnapshot | null {
    return this.#byThread.get(threadId) ?? null;
  }

  clear(): void {
    this.#byThread.clear();
  }
}

export class RendererReasoningPendingBuffer {
  readonly #maxTextLength: number;
  readonly #events: RendererReasoningEvent[] = [];
  #textLength = 0;

  constructor(maxTextLength = DEFAULT_PENDING_REASONING_TEXT_LIMIT) {
    this.#maxTextLength = maxTextLength;
  }

  append(event: RendererReasoningEvent): boolean {
    const last = this.#events.at(-1);
    const sameItem =
      last?.threadId === event.threadId &&
      last.turnId === event.turnId &&
      last.itemId === event.itemId;
    const replacesPending =
      !sameItem ||
      event.kind === "started" ||
      event.kind === "completed" ||
      last?.kind === "completed";
    const retainedTextLength = replacesPending ? 0 : this.#textLength;
    if (retainedTextLength + event.text.length > this.#maxTextLength) return false;
    if (replacesPending) {
      this.#events.splice(0, this.#events.length);
      this.#textLength = 0;
    }
    if (event.kind === "delta" && last?.kind === "delta" && sameItem && !replacesPending) {
      this.#events[this.#events.length - 1] = Object.freeze({
        ...last,
        text: `${last.text}${event.text}`,
      });
    } else {
      this.#events.push(event);
    }
    this.#textLength += event.text.length;
    return true;
  }

  drain(): readonly RendererReasoningEvent[] {
    const events = this.#events.splice(0, this.#events.length);
    this.#textLength = 0;
    return events;
  }
}

export function rendererReasoningPanelView(
  snapshot: RendererReasoningSnapshot | null,
): RendererReasoningPanelView {
  return {
    visible: Boolean(snapshot?.text.trim()),
    expanded: snapshot?.phase !== "completed",
    phase: snapshot?.phase ?? "live",
    text: snapshot?.text ?? "",
  };
}
