import type {
  HarnessOutput,
  HostItem,
  HostItemOutcome,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { KiroTransportEvent } from "./acp-transport.js";
import { projectKiroFileChanges } from "./file-diff.js";
import { projectKiroToolCall } from "./projection.js";

type ToolEvent = Extract<KiroTransportEvent, { type: "tool.call" | "tool.update" }>;

/** Owns one Prompt's Items; published objects are never mutated afterwards. */
export class KiroTurnOutput {
  readonly #tools = new Map<string, { event: ToolEvent; item: HostItem; done: boolean }>();
  #message: Extract<HostItem, { type: "agentMessage" }> | undefined;
  #finished = false;

  constructor(
    readonly turnId: HostTurnId,
    readonly cwd: string,
    readonly emit: (output: HarnessOutput) => void,
  ) {}

  #start(item: HostItem): void {
    this.emit({ kind: "event", event: { type: "item.started", turnId: this.turnId, item } });
  }

  #complete(item: HostItem, outcome: HostItemOutcome): void {
    this.emit({
      kind: "event",
      event: {
        type: "item.completed",
        turnId: this.turnId,
        snapshot: { item, outcome },
      },
    });
  }

  accept(event: KiroTransportEvent): void {
    if (this.#finished) return;
    if (event.type === "agent.text") {
      if (!this.#message) {
        this.#message = {
          type: "agentMessage",
          itemId: hostItemIdSchema.parse(`agent-${this.turnId}`),
          text: "",
        };
        this.#start(this.#message);
      }
      this.#message = { ...this.#message, text: this.#message.text + event.text };
      this.emit({
        kind: "event",
        event: {
          type: "item.updated",
          turnId: this.turnId,
          itemId: this.#message.itemId,
          update: { type: "text.append", text: event.text },
        },
      });
    } else if (event.type === "tool.call" || event.type === "tool.update") {
      const previous = this.#tools.get(event.callId);
      // A completion without a start belongs to Session initialization, not this Prompt.
      if (previous?.done || (!previous && event.type === "tool.update")) return;
      const merged = {
        ...previous?.event,
        ...Object.fromEntries(
          Object.entries(event).filter(([, value]) => value !== undefined && value !== null),
        ),
      } as ToolEvent;
      const itemId = hostItemIdSchema.parse(`tool-${this.turnId}-${event.callId}`);
      const item = projectKiroToolCall(itemId, { ...merged, toolCallId: event.callId });
      if (previous && previous.item.type !== item.type) {
        throw new Error("Kiro changed an active tool's type");
      }
      if (!previous) this.#start(item);
      const done = merged.status === "completed" || merged.status === "failed";
      this.#tools.set(event.callId, { event: merged, item, done });
      if (!done) return;
      const outcome: HostItemOutcome =
        merged.status === "completed"
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: { code: "nativeFailure", message: "Kiro tool failed", retryable: false },
            };
      this.#complete(item, outcome);
      // Only the terminal update's Diff is evidence of a committed modification.
      const changes =
        outcome.status === "succeeded" ? projectKiroFileChanges(event.content, this.cwd) : null;
      if (changes) {
        const file: HostItem = {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(`file-${itemId}`),
          changes,
        };
        this.#start(file);
        this.#complete(file, { status: "succeeded" });
      }
    }
  }

  finish(outcome: TurnOutcome): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#message) this.#complete(this.#message, outcome);
    for (const tool of this.#tools.values()) {
      if (!tool.done)
        this.#complete(
          tool.item,
          outcome.status === "succeeded"
            ? { status: "cancelled", reason: "Kiro ended the turn without a tool result" }
            : outcome,
        );
    }
  }
}
