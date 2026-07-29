import type {
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemUpdate,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId, JsonObject, JsonValue } from "@codexhost/shared-contracts";

export type ProjectableHostEvent =
  TurnStartedEvent | ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent | TurnCompletedEvent;

export interface CodexTurnProjection {
  messages: JsonObject[];
  completedTurn?: JsonObject;
}

interface ProjectedItem {
  item: HostItem;
  outcome: HostItemOutcome | null;
  streamedCommandOutput: boolean;
}

function itemStatus(outcome: HostItemOutcome | null): "inProgress" | "completed" | "failed" {
  if (!outcome) return "inProgress";
  return outcome.status === "succeeded" ? "completed" : "failed";
}

function toolContentItems(item: Extract<HostItem, { type: "toolExecution" }>): JsonValue[] | null {
  if (!item.output) return null;
  return item.output.content.map((content) =>
    content.type === "text"
      ? { type: "inputText", text: content.text }
      : {
          type: "inputImage",
          imageUrl: `data:${content.mimeType};base64,${content.base64Data}`,
        },
  );
}

function projectItem(
  item: HostItem,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
  includeCommandOutput = true,
): JsonObject {
  switch (item.type) {
    case "agentMessage":
      return {
        id: item.itemId,
        type: "agentMessage",
        text: item.text,
        phase: null,
        memoryCitation: null,
      };
    case "commandExecution":
      return {
        id: item.itemId,
        type: "commandExecution",
        command: item.command,
        cwd: item.cwd ?? defaultCwd,
        processId: null,
        source: "agent",
        status: itemStatus(outcome),
        commandActions: [],
        aggregatedOutput: includeCommandOutput ? (item.output ?? null) : null,
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
      };
    case "toolExecution": {
      const status = itemStatus(outcome);
      return {
        id: item.itemId,
        type: "dynamicToolCall",
        namespace: item.namespace ?? null,
        tool: item.toolName,
        arguments: item.arguments,
        status,
        contentItems: toolContentItems(item),
        success: outcome ? outcome.status === "succeeded" : null,
        durationMs: item.durationMs ?? null,
      };
    }
    case "fileChange":
      return {
        id: item.itemId,
        type: "fileChange",
        changes: item.changes.map(({ path, kind, unifiedDiff }) => ({
          path,
          kind,
          diff: unifiedDiff,
        })),
        status: itemStatus(outcome),
      };
  }
}

function turnStatus(
  outcome: TurnCompletedEvent["outcome"],
): "completed" | "interrupted" | "failed" {
  if (outcome.status === "succeeded") return "completed";
  if (outcome.status === "cancelled") return "interrupted";
  return "failed";
}

function turnError(outcome: TurnCompletedEvent["outcome"]): JsonObject | null {
  return outcome.status === "failed"
    ? {
        message: outcome.error.message,
        codexErrorInfo: "other",
        additionalDetails: null,
      }
    : null;
}

function applyUpdate(item: HostItem, update: HostItemUpdate): HostItem {
  if (item.type === "agentMessage" && update.type === "text.append") {
    return { ...item, text: item.text + update.text };
  }
  if (item.type === "commandExecution" && update.type === "output.append") {
    return { ...item, output: (item.output ?? "") + update.text };
  }
  if (item.type === "toolExecution" && update.type === "output.replace") {
    return { ...item, output: update.output };
  }
  if (item.type === "fileChange" && update.type === "fileChanges.replace") {
    return { ...item, changes: update.changes };
  }
  throw new Error(`Host Item '${item.type}' cannot apply update '${update.type}'`);
}

function diffText(changes: HostFileChange[]): string {
  return changes.map(({ unifiedDiff }) => unifiedDiff).join("\n");
}

export class CodexTurnProjector {
  readonly #cwd: string;
  readonly #items = new Map<HostItemId, ProjectedItem>();
  readonly #itemOrder: HostItemId[] = [];
  readonly #startedAt: number;
  readonly #startedAtMs: number;
  readonly #threadId: string;
  readonly #turnId: HostTurnId;
  #completed = false;
  #started = false;

  constructor(input: { threadId: string; turnId: HostTurnId; cwd: string; startedAtMs: number }) {
    this.#threadId = input.threadId;
    this.#turnId = input.turnId;
    this.#cwd = input.cwd;
    this.#startedAtMs = input.startedAtMs;
    this.#startedAt = Math.floor(input.startedAtMs / 1000);
  }

  pendingTurn(startedAt: number | null = null): JsonObject {
    return {
      id: this.#turnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
      itemsView: "full",
    };
  }

  project(event: ProjectableHostEvent, emittedAtMs = Date.now()): CodexTurnProjection {
    if (event.turnId !== this.#turnId) {
      throw new Error("Host output references another Turn");
    }
    if (this.#completed) throw new Error("Host output follows the Turn terminal event");
    switch (event.type) {
      case "turn.started":
        return this.#startTurn();
      case "item.started":
        return this.#startItem(event);
      case "item.updated":
        return this.#updateItem(event, emittedAtMs);
      case "item.completed":
        return this.#completeItem(event, emittedAtMs);
      case "turn.completed":
        return this.#completeTurn(event, emittedAtMs);
    }
  }

  #startTurn(): CodexTurnProjection {
    if (this.#started) throw new Error("Host Turn started more than once");
    this.#started = true;
    return {
      messages: [
        {
          method: "turn/started",
          emittedAtMs: this.#startedAtMs,
          params: {
            threadId: this.#threadId,
            turn: this.pendingTurn(this.#startedAt),
          },
        },
      ],
    };
  }

  #startItem(event: ItemStartedEvent): CodexTurnProjection {
    this.#requireStarted();
    if (this.#items.has(event.item.itemId)) throw new Error("Host Item started more than once");
    this.#items.set(event.item.itemId, {
      item: event.item,
      outcome: null,
      streamedCommandOutput: false,
    });
    this.#itemOrder.push(event.item.itemId);
    const messages: JsonObject[] = [
      {
        method: "item/started",
        emittedAtMs: this.#startedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          startedAtMs: this.#startedAtMs,
          item: projectItem(event.item, null, this.#cwd),
        },
      },
    ];
    if (event.item.type === "fileChange") {
      messages.push(...this.#fileChangeUpdates(event.item.itemId, event.item.changes));
    }
    return { messages };
  }

  #updateItem(event: ItemUpdatedEvent, emittedAtMs: number): CodexTurnProjection {
    const projected = this.#activeItem(event.itemId);
    const next = applyUpdate(projected.item, event.update);
    projected.item = next;
    const messages: JsonObject[] = [];
    if (event.update.type === "text.append") {
      messages.push({
        method: "item/agentMessage/delta",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId: event.itemId,
          delta: event.update.text,
        },
      });
    } else if (event.update.type === "output.append") {
      projected.streamedCommandOutput = true;
      messages.push({
        method: "item/commandExecution/outputDelta",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId: event.itemId,
          delta: event.update.text,
        },
      });
    } else if (event.update.type === "fileChanges.replace") {
      messages.push(...this.#fileChangeUpdates(event.itemId, event.update.changes));
    }
    return { messages };
  }

  #completeItem(event: ItemCompletedEvent, emittedAtMs: number): CodexTurnProjection {
    const projected = this.#activeItem(event.snapshot.item.itemId);
    if (event.snapshot.item.type !== projected.item.type) {
      throw new Error("Host Item changed type before completion");
    }
    projected.item = event.snapshot.item;
    projected.outcome = event.snapshot.outcome;
    return {
      messages: [
        {
          method: "item/completed",
          emittedAtMs,
          params: {
            threadId: this.#threadId,
            turnId: this.#turnId,
            completedAtMs: emittedAtMs,
            item: projectItem(
              projected.item,
              projected.outcome,
              this.#cwd,
              !projected.streamedCommandOutput,
            ),
          },
        },
      ],
    };
  }

  #completeTurn(event: TurnCompletedEvent, completedAtMs: number): CodexTurnProjection {
    this.#requireStarted();
    const active = [...this.#items.values()].filter(({ outcome }) => outcome === null);
    if (active.length > 0) throw new Error("Host Turn completed with active Items");
    this.#completed = true;
    const completedAt = Math.floor(completedAtMs / 1000);
    const error = turnError(event.outcome);
    const turn: JsonObject = {
      id: this.#turnId,
      status: turnStatus(event.outcome),
      // Current Codex sends Tool/File Change state through Item notifications only.
      items: this.#itemOrder.flatMap((itemId) => {
        const projected = this.#items.get(itemId);
        if (!projected?.outcome) throw new Error("Host Turn contains an incomplete Item");
        return projected.item.type === "agentMessage"
          ? [projectItem(projected.item, projected.outcome, this.#cwd)]
          : [];
      }),
      error,
      startedAt: this.#startedAt,
      completedAt,
      durationMs: Math.max(0, completedAtMs - this.#startedAtMs),
      itemsView: "full",
    };
    return {
      completedTurn: turn,
      messages: [
        ...(error
          ? [
              {
                method: "error",
                params: {
                  error,
                  willRetry: false,
                  threadId: this.#threadId,
                  turnId: this.#turnId,
                },
              },
            ]
          : []),
        {
          method: "turn/completed",
          emittedAtMs: completedAtMs,
          params: { threadId: this.#threadId, turn },
        },
      ],
    };
  }

  #fileChangeUpdates(itemId: HostItemId, changes: HostFileChange[]): JsonObject[] {
    const projectedChanges = changes.map(({ path, kind, unifiedDiff }) => ({
      path,
      kind,
      diff: unifiedDiff,
    }));
    return [
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId,
          changes: projectedChanges,
        },
      },
      {
        method: "turn/diff/updated",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          diff: diffText(this.#allFileChanges()),
        },
      },
    ];
  }

  #allFileChanges(): HostFileChange[] {
    return this.#itemOrder.flatMap((itemId) => {
      const item = this.#items.get(itemId)?.item;
      return item?.type === "fileChange" ? item.changes : [];
    });
  }

  #activeItem(itemId: HostItemId): ProjectedItem {
    const projected = this.#items.get(itemId);
    if (!projected) throw new Error("Host output references an unknown Item");
    if (projected.outcome) throw new Error("Host output follows the Item terminal event");
    return projected;
  }

  #requireStarted(): void {
    if (!this.#started) throw new Error("Host Item or terminal output precedes turn.started");
  }
}
