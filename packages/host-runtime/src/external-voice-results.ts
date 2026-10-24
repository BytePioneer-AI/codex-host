import type { HostEvent } from "@codexhost/harness-adapter";
import { externalVoiceContentText } from "./external-voice-presentation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Speakable Agent Message text already projected for Desktop, including inferred final answers. */
export function speakableFromProjectedTurn(turn: unknown): string | undefined {
  if (!isRecord(turn) || !Array.isArray(turn.items)) return undefined;
  const messages = turn.items.filter(
    (item): item is Record<string, unknown> & { text: string } =>
      isRecord(item) && item.type === "agentMessage" && typeof item.text === "string",
  );
  return speakableFromItems(messages);
}

function speakableFromItems(
  items: Iterable<{ text: string; phase?: unknown }>,
): string | undefined {
  const values = [...items];
  const finals = values.filter((item) => item.phase === "final_answer");
  const text = (
    finals.length ? finals : values.filter((item) => item.phase !== "commentary").slice(-1)
  )
    .map((item) => externalVoiceContentText(item.text))
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** Fan-out from the existing Host consumer; never consumes HarnessSession.outputs. */
export class ExternalVoiceResults {
  constructor(readonly onProgress?: (threadId: string, text: string) => void) {}

  readonly #pending = new Map<
    string,
    {
      threadId: string;
      items: Map<string, { text: string; phase?: string; completed?: boolean }>;
      resolve(text: string): void;
      reject(error: Error): void;
      dispose(): void;
    }
  >();

  has(threadId: string, turnId: string): boolean {
    return this.#pending.get(turnId)?.threadId === threadId;
  }

  watch(threadId: string, turnId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new Error("Voice session ended"));
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.#pending.delete(turnId);
        reject(new Error("Voice session ended"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(turnId, {
        threadId,
        items: new Map(),
        resolve,
        reject,
        dispose: () => signal.removeEventListener("abort", abort),
      });
    });
  }

  observe(threadId: string, event: HostEvent, projectedTurn?: unknown): void {
    if (event.type === "session.faulted") {
      for (const [turnId, pending] of this.#pending) {
        if (pending.threadId !== threadId) continue;
        this.#pending.delete(turnId);
        pending.dispose();
        pending.reject(new Error("External agent session failed"));
      }
      return;
    }
    if (!("turnId" in event)) return;
    const pending = this.#pending.get(event.turnId);
    if (!pending || pending.threadId !== threadId) return;
    if (event.type === "item.started") {
      // A later Item makes an unphased, completed Agent Message progress rather
      // than the Turn's inferred final answer. Never publish partial text.
      for (const item of pending.items.values()) {
        if (!item.completed || item.phase !== undefined) continue;
        item.phase = "commentary";
        if (item.text.trim()) this.onProgress?.(threadId, item.text);
      }
    }
    if (event.type === "item.started" && event.item.type === "agentMessage") {
      pending.items.set(event.item.itemId, {
        text: event.item.text,
        ...(event.item.phase ? { phase: event.item.phase } : {}),
      });
    }
    if (event.type === "item.updated" && event.update.type === "text.append") {
      const item = pending.items.get(event.itemId);
      if (item) item.text += event.update.text;
    }
    if (
      event.type === "item.completed" &&
      event.snapshot.item.type === "agentMessage" &&
      event.snapshot.outcome.status === "succeeded"
    ) {
      const item = event.snapshot.item;
      const previous = pending.items.get(item.itemId);
      if (item.phase === "commentary" && item.text.trim() && !previous?.completed) {
        this.onProgress?.(threadId, item.text);
      }
      const phase = item.phase ?? previous?.phase;
      pending.items.set(item.itemId, {
        text: item.text,
        ...(phase ? { phase } : {}),
        completed: true,
      });
    }
    if (event.type !== "turn.completed") return;
    this.#pending.delete(event.turnId);
    pending.dispose();
    if (event.outcome.status !== "succeeded") {
      pending.reject(new Error("External agent task did not complete"));
      return;
    }
    const text =
      speakableFromItems(pending.items.values()) ?? speakableFromProjectedTurn(projectedTurn);
    if (!text) {
      pending.reject(new Error("External agent returned no spoken result"));
      return;
    }
    pending.resolve(text);
  }
}
