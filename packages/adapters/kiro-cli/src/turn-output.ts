import type {
  HarnessOutput,
  HostItem,
  HostFileChangeItem,
  HostItemOutcome,
  TurnOutcome,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import type { KiroTransportEvent } from "./acp-transport.js";
import { projectKiroFileChanges } from "./file-diff.js";
import { projectKiroToolCall } from "./projection.js";
import { KiroVisibleText } from "./visible-text.js";

type ToolEvent = Extract<KiroTransportEvent, { type: "tool.call" | "tool.update" }>;
type ToolState = { event: ToolEvent; item: HostItem; done: boolean; file?: HostFileChangeItem };

/** Owns one Prompt's Items; published objects are never mutated afterwards. */
export class KiroTurnOutput {
  readonly #tools = new Map<string, ToolState>();
  #message: Extract<HostItem, { type: "agentMessage" }> | undefined;
  #messageId: string | undefined;
  #messageIndex = 0;
  #finished = false;
  readonly #text = new KiroVisibleText();
  #leadingWhitespace = "";

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

  #completeMessage(outcome: HostItemOutcome, phase: "commentary" | "final_answer"): void {
    this.#appendText(this.#text.finish());
    if (this.#message) this.#complete({ ...this.#message, phase }, outcome);
    this.#message = undefined;
    this.#messageId = undefined;
    this.#leadingWhitespace = "";
  }

  #fileOutput(tool: ToolState, content: unknown, outcome?: HostItemOutcome): void {
    const changes =
      !outcome || outcome.status === "succeeded" ? projectKiroFileChanges(content, this.cwd) : null;
    if (changes || (outcome && tool.file)) {
      const file: HostFileChangeItem = {
        type: "fileChange",
        itemId: hostItemIdSchema.parse(`file-${tool.item.itemId}`),
        changes: changes ?? [],
      };
      if (tool.file) {
        this.emit({
          kind: "event",
          event: {
            type: "item.updated",
            turnId: this.turnId,
            itemId: file.itemId,
            update: { type: "fileChanges.replace", changes: file.changes },
          },
        });
      } else this.#start(file);
      tool.file = file;
    }
    // A preview is not a committed change. Clear it unless the terminal update confirms its Diff.
    if (outcome && tool.file)
      this.#complete(
        tool.file,
        outcome.status === "succeeded" && !changes
          ? { status: "cancelled", reason: "Kiro did not confirm the previewed modification" }
          : outcome,
      );
  }

  #appendText(text: string): void {
    if (!text) return;
    if (!this.#message) {
      text = this.#leadingWhitespace + text;
      if (!text.trim()) {
        this.#leadingWhitespace = text;
        return;
      }
      this.#leadingWhitespace = "";
      this.#message = {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(`agent-${this.turnId}-${this.#messageIndex++}`),
        text: "",
        phase: "commentary",
      };
      this.#start(this.#message);
    }
    this.#message = { ...this.#message, text: this.#message.text + text };
    this.emit({
      kind: "event",
      event: {
        type: "item.updated",
        turnId: this.turnId,
        itemId: this.#message.itemId,
        update: { type: "text.append", text },
      },
    });
  }

  accept(event: KiroTransportEvent): void {
    if (this.#finished) return;
    if (event.type === "agent.text") {
      if (
        event.messageId !== undefined &&
        this.#messageId !== undefined &&
        event.messageId !== this.#messageId
      ) {
        this.#completeMessage({ status: "succeeded" }, "commentary");
      }
      if (event.messageId !== undefined) this.#messageId = event.messageId;
      this.#appendText(this.#text.push(event.text));
    } else if (event.type === "tool.call" || event.type === "tool.update") {
      const previous = this.#tools.get(event.callId);
      // A completion without a start belongs to Session initialization, not this Prompt.
      if (previous?.done || (!previous && event.type === "tool.update")) return;
      if (!previous) this.#completeMessage({ status: "succeeded" }, "commentary");
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
      const tool: ToolState = { ...previous, event: merged, item, done };
      this.#tools.set(event.callId, tool);
      if (!done) {
        this.#fileOutput(tool, event.content);
        return;
      }
      const outcome: HostItemOutcome =
        merged.status === "completed"
          ? { status: "succeeded" }
          : {
              status: "failed",
              error: { code: "nativeFailure", message: "Kiro tool failed", retryable: false },
            };
      this.#complete(item, outcome);
      this.#fileOutput(tool, event.content, outcome);
    }
  }

  finish(outcome: TurnOutcome): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#completeMessage(outcome, outcome.status === "succeeded" ? "final_answer" : "commentary");
    for (const tool of this.#tools.values()) {
      if (!tool.done) {
        this.#fileOutput(tool, undefined, outcome);
        this.#complete(
          tool.item,
          outcome.status === "succeeded"
            ? { status: "cancelled", reason: "Kiro ended the turn without a tool result" }
            : outcome,
        );
      }
    }
  }
}
