import type {
  HostApprovalInteraction,
  HostFileChange,
  HostItem,
  HostItemOutcome,
  HostItemUpdate,
  HostQuestionInteraction,
  HostTurnSnapshot,
  HistoricalTurnOutcome,
  InteractionClosedEvent,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  TurnCompletedEvent,
  TurnStartedEvent,
} from "@codexhost/harness-adapter";
import type {
  HostInteractionId,
  HostItemId,
  HostTurnId,
  JsonObject,
  JsonValue,
} from "@codexhost/shared-contracts";
import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";

import {
  projectCodexApprovalRequest,
  type CodexApprovalRequestProjection,
} from "./codex-approval.js";
import {
  projectCodexQuestionRequest,
  type CodexQuestionRequestProjection,
} from "./codex-question.js";
import { formatCollabSpawnModel } from "./codex-collab-spawn-model.js";

export type ProjectableHostEvent =
  | TurnStartedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | InteractionClosedEvent
  | TurnCompletedEvent;

export interface CodexTurnProjection {
  messages: JsonObject[];
  completedTurn?: JsonObject;
}

export interface CodexApprovalProjection extends CodexTurnProjection {
  approvalRequest: CodexApprovalRequestProjection;
}

export interface CodexQuestionProjection extends CodexTurnProjection {
  itemId: HostItemId;
  questionRequest: CodexQuestionRequestProjection;
}

export interface HistoricalTurnProjectionInput {
  turnId: HostTurnId;
  cwd: string;
  snapshot: HostTurnSnapshot;
}

interface ProjectedItem {
  item: HostItem;
  outcome: HostItemOutcome | null;
  reasoningPartStarted: boolean;
  streamedCommandOutput: boolean;
  wireStarted: boolean;
}

type ProjectedInteraction =
  { type: "approval" } | { type: "question"; itemId: HostItemId; syntheticItem: boolean };

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

function collabAgentStatus(
  status: Extract<HostItem, { type: "subagentDelegation" }>["subagents"][number]["status"],
): string {
  switch (status) {
    case "pending":
      return "pendingInit";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "interrupted":
      return "interrupted";
  }
}

function collabAgentModel(
  subagent: Extract<HostItem, { type: "subagentDelegation" }>["subagents"][number] | undefined,
): string | null {
  return formatCollabSpawnModel(subagent?.model, subagent?.reasoningEffort);
}

function projectItem(
  item: HostItem,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
  includeCommandOutput = true,
  senderThreadId?: string,
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
    case "reasoning":
      return {
        id: reasoningPreviewItemId(item.itemId),
        type: "reasoning",
        summary: item.text.length > 0 ? [item.text] : [],
        content: [],
      };
    case "contextCompaction":
      return { id: item.itemId, type: "contextCompaction" };
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
    case "subagentDelegation": {
      const primary = item.subagents[0];
      return {
        id: item.itemId,
        type: "collabAgentToolCall",
        tool: item.operation === "spawn" ? "spawnAgent" : "sendInput",
        status: itemStatus(outcome),
        senderThreadId: senderThreadId ?? "",
        receiverThreadIds: item.subagents.map(({ subagentId }) => subagentId),
        prompt: item.prompt ?? null,
        model: collabAgentModel(primary),
        reasoningEffort: primary?.reasoningEffort ?? null,
        agentsStates: Object.fromEntries(
          item.subagents.map(({ subagentId, status, resultSummary }) => [
            subagentId,
            { status: collabAgentStatus(status), message: resultSummary ?? null },
          ]),
        ),
      };
    }
  }
}

/**
 * Codex only renders a Command Execution card for the Item id it was given by
 * the Host, so the transcript twin keeps the original id and the ephemeral
 * native Reasoning preview takes the derived one.
 */
export function reasoningPreviewItemId(itemId: HostItemId): string {
  return `${itemId}-summary`;
}

/**
 * Codex renders Reasoning summary deltas as an ephemeral one-line preview but
 * keeps no text after the Turn. The Command Execution lane is the one that
 * retains text, so each Reasoning Item also projects a parallel transcript twin.
 */
function projectReasoningTranscriptItem(
  item: Extract<HostItem, { type: "reasoning" }>,
  outcome: HostItemOutcome | null,
  defaultCwd: string,
): JsonObject {
  return {
    id: item.itemId,
    type: "commandExecution",
    command: REASONING_TRANSCRIPT_COMMAND,
    cwd: defaultCwd,
    processId: null,
    source: "agent",
    status: itemStatus(outcome),
    commandActions: [],
    aggregatedOutput: item.text.length > 0 ? item.text : null,
    exitCode: outcome ? 0 : null,
    durationMs: null,
  };
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

function historicalStatus(outcome: HistoricalTurnOutcome): "completed" | "interrupted" | "failed" {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "cancelled") return "interrupted";
  return "completed";
}

export function projectHistoricalTurn(input: HistoricalTurnProjectionInput): JsonObject {
  const { turnId, cwd, snapshot } = input;
  const error =
    snapshot.outcome.status === "failed"
      ? {
          message: snapshot.outcome.error.message,
          codexErrorInfo: "other",
          additionalDetails: null,
        }
      : null;
  return {
    id: turnId,
    status: historicalStatus(snapshot.outcome),
    items: [
      {
        id: `${turnId}-user`,
        type: "userMessage",
        clientId: null,
        content: snapshot.input.map(({ text }) => ({ type: "text", text })),
      },
      ...snapshot.items.flatMap(({ item, outcome }) =>
        item.type === "reasoning"
          ? [
              projectItem(item, outcome, cwd, true, ""),
              projectReasoningTranscriptItem(item, outcome, cwd),
            ]
          : [projectItem(item, outcome, cwd, true, "")],
      ),
    ],
    error,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    itemsView: "full",
  };
}

function applyUpdate(item: HostItem, update: HostItemUpdate): HostItem {
  if (
    (item.type === "agentMessage" || item.type === "reasoning") &&
    update.type === "text.append"
  ) {
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
  if (item.type === "subagentDelegation" && update.type === "subagents.replace") {
    return { ...item, subagents: update.subagents };
  }
  throw new Error(`Host Item '${item.type}' cannot apply update '${update.type}'`);
}

function diffText(changes: HostFileChange[]): string {
  return changes.map(({ unifiedDiff }) => unifiedDiff).join("\n");
}

export class CodexTurnProjector {
  readonly #cwd: string;
  readonly #input: HostTurnSnapshot["input"];
  readonly #interactions = new Map<HostInteractionId, ProjectedInteraction>();
  readonly #items = new Map<HostItemId, ProjectedItem>();
  readonly #itemOrder: HostItemId[] = [];
  readonly #wireItemOrder: HostItemId[] = [];
  readonly #startedAt: number;
  readonly #startedAtMs: number;
  readonly #threadId: string;
  readonly #turnId: HostTurnId;
  #completed = false;
  #started = false;

  constructor(input: {
    threadId: string;
    turnId: HostTurnId;
    cwd: string;
    startedAtMs: number;
    initialInput?: HostTurnSnapshot["input"];
  }) {
    this.#threadId = input.threadId;
    this.#turnId = input.turnId;
    this.#cwd = input.cwd;
    this.#input = input.initialInput ?? [];
    this.#startedAtMs = input.startedAtMs;
    this.#startedAt = Math.floor(input.startedAtMs / 1000);
  }

  pendingTurn(startedAt: number | null = null): JsonObject {
    return {
      id: this.#turnId,
      status: "inProgress",
      items: [
        ...this.#projectInput(),
        ...this.#wireItemOrder.flatMap((itemId) => {
          const projected = this.#items.get(itemId);
          return projected?.wireStarted && projected.item.type === "agentMessage"
            ? [projectItem(projected.item, projected.outcome, this.#cwd)]
            : [];
        }),
      ],
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
      case "interaction.closed":
        return this.#closeInteraction(event, emittedAtMs);
      case "turn.completed":
        return this.#completeTurn(event, emittedAtMs);
    }
  }

  projectApproval(
    interaction: HostApprovalInteraction,
    serverName: string,
  ): CodexApprovalProjection {
    if (interaction.turnId !== this.#turnId) {
      throw new Error("Host Interaction references another Turn");
    }
    this.#requireStarted();
    if (this.#completed) throw new Error("Host Interaction follows the Turn terminal event");
    if (this.#interactions.has(interaction.interactionId)) {
      throw new Error("Host Interaction opened more than once");
    }
    const approvalRequest = projectCodexApprovalRequest({
      threadId: this.#threadId,
      interaction,
      serverName,
    });
    this.#interactions.set(interaction.interactionId, { type: "approval" });
    return { messages: [], approvalRequest };
  }

  projectQuestion(
    interaction: HostQuestionInteraction,
    syntheticItemId: HostItemId,
    emittedAtMs = Date.now(),
  ): CodexQuestionProjection {
    if (interaction.turnId !== this.#turnId) {
      throw new Error("Host Interaction references another Turn");
    }
    this.#requireStarted();
    if (this.#completed) throw new Error("Host Interaction follows the Turn terminal event");
    if (this.#interactions.has(interaction.interactionId)) {
      throw new Error("Host Interaction opened more than once");
    }

    const messages: JsonObject[] = [];
    const itemId = interaction.itemId ?? syntheticItemId;
    const syntheticItem = interaction.itemId === undefined;
    if (!syntheticItem) {
      const item = this.#activeItem(itemId).item;
      if (item.type !== "toolExecution") {
        throw new Error("Host Question Item must be an active Generic Tool");
      }
    }
    const questionRequest = projectCodexQuestionRequest({
      threadId: this.#threadId,
      interaction,
      itemId,
      emittedAtMs,
    });
    if (syntheticItem) {
      const item: HostItem = {
        type: "toolExecution",
        itemId,
        namespace: "codexhost",
        toolName: "question",
        arguments: {},
      };
      messages.push(
        ...this.#startItem({ type: "item.started", turnId: this.#turnId, item }).messages,
      );
    }
    this.#interactions.set(interaction.interactionId, {
      type: "question",
      itemId,
      syntheticItem,
    });
    return { messages, itemId, questionRequest };
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
    const projected: ProjectedItem = {
      item: event.item,
      outcome: null,
      reasoningPartStarted: false,
      streamedCommandOutput: false,
      wireStarted: false,
    };
    this.#items.set(event.item.itemId, projected);
    this.#itemOrder.push(event.item.itemId);
    if (
      (event.item.type === "agentMessage" || event.item.type === "reasoning") &&
      event.item.text.length === 0
    ) {
      // An empty Reasoning Item would surface as a transcript card with no
      // content, so defer the wire Item until real summary text arrives.
      return { messages: [] };
    }
    const startedItem = event.item.type === "reasoning" ? { ...event.item, text: "" } : event.item;
    const messages = [this.#startWireItem(projected, startedItem)];
    if (event.item.type === "reasoning") {
      messages.push(
        this.#startReasoningTranscript(event.item, this.#startedAtMs),
        this.#reasoningOutputDelta(event.item.itemId, event.item.text, this.#startedAtMs),
        ...this.#reasoningDelta(projected, event.item.text, this.#startedAtMs),
      );
    }
    if (event.item.type === "fileChange") {
      messages.push(...this.#fileChangeUpdates(event.item.itemId, event.item.changes));
    }
    return { messages };
  }

  #updateItem(event: ItemUpdatedEvent, emittedAtMs: number): CodexTurnProjection {
    const projected = this.#activeItem(event.itemId);
    const previous = projected.item;
    const next = applyUpdate(previous, event.update);
    projected.item = next;
    const messages: JsonObject[] = [];
    if (event.update.type === "text.append") {
      if (event.update.text.length === 0) return { messages };
      if (next.type === "agentMessage") {
        if (!projected.wireStarted) messages.push(this.#startWireItem(projected, previous));
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
      } else if (next.type === "reasoning") {
        if (!projected.wireStarted) {
          messages.push(
            this.#startWireItem(projected, { ...next, text: "" }),
            this.#startReasoningTranscript({ ...next, text: "" }, emittedAtMs),
          );
        }
        messages.push(
          this.#reasoningOutputDelta(event.itemId, event.update.text, emittedAtMs),
          ...this.#reasoningDelta(projected, event.update.text, emittedAtMs),
        );
      }
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
    } else if (event.update.type === "subagents.replace") {
      messages.push({
        method: "item/started",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          startedAtMs: this.#startedAtMs,
          item: projectItem(next, null, this.#cwd, true, this.#threadId),
        },
      });
    }
    return { messages };
  }

  #completeItem(event: ItemCompletedEvent, emittedAtMs: number): CodexTurnProjection {
    if (
      [...this.#interactions.values()].some(
        (interaction) =>
          interaction.type === "question" && interaction.itemId === event.snapshot.item.itemId,
      )
    ) {
      throw new Error("Host Item completed with a pending Interaction");
    }
    const projected = this.#activeItem(event.snapshot.item.itemId);
    if (event.snapshot.item.type !== projected.item.type) {
      throw new Error("Host Item changed type before completion");
    }
    if (projected.item.type === "agentMessage" || projected.item.type === "reasoning") {
      const completedItem = event.snapshot.item;
      if (
        (completedItem.type !== "agentMessage" && completedItem.type !== "reasoning") ||
        completedItem.text !== projected.item.text
      ) {
        throw new Error("Host textual Item completion does not match its append updates");
      }
    }
    projected.item = event.snapshot.item;
    projected.outcome = event.snapshot.outcome;
    if (!projected.wireStarted) return { messages: [] };
    const completedItem = (item: JsonObject): JsonObject => ({
      method: "item/completed",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        completedAtMs: emittedAtMs,
        item,
      },
    });
    const messages = [
      completedItem(
        projectItem(
          projected.item,
          projected.outcome,
          this.#cwd,
          !projected.streamedCommandOutput,
          this.#threadId,
        ),
      ),
    ];
    if (projected.item.type === "reasoning") {
      messages.push(
        completedItem(projectReasoningTranscriptItem(projected.item, projected.outcome, this.#cwd)),
      );
    }
    return { messages };
  }

  #closeInteraction(event: InteractionClosedEvent, emittedAtMs: number): CodexTurnProjection {
    const interaction = this.#interactions.get(event.interactionId);
    if (!interaction) throw new Error("Host output closes an unknown Interaction");
    this.#interactions.delete(event.interactionId);
    if (interaction.type === "approval" || !interaction.syntheticItem) return { messages: [] };
    const projected = this.#activeItem(interaction.itemId);
    return this.#completeItem(
      {
        type: "item.completed",
        turnId: this.#turnId,
        snapshot: {
          item: projected.item,
          outcome:
            event.reason === "responded"
              ? { status: "succeeded" }
              : { status: "cancelled", reason: `Question ${event.reason}` },
        },
      },
      emittedAtMs,
    );
  }

  #completeTurn(event: TurnCompletedEvent, completedAtMs: number): CodexTurnProjection {
    this.#requireStarted();
    if (this.#interactions.size > 0) {
      throw new Error("Host Turn completed with pending Interactions");
    }
    const active = [...this.#items.values()].filter(({ outcome }) => outcome === null);
    if (active.length > 0) throw new Error("Host Turn completed with active Items");
    this.#completed = true;
    const completedAt = Math.floor(completedAtMs / 1000);
    const error = turnError(event.outcome);
    const turn: JsonObject = {
      id: this.#turnId,
      status: turnStatus(event.outcome),
      // Current Codex sends Tool/File Change state through Item notifications only.
      items: [
        ...this.#projectInput(),
        ...this.#wireItemOrder.flatMap((itemId) => {
          const projected = this.#items.get(itemId);
          if (!projected?.outcome) throw new Error("Host Turn contains an incomplete Item");
          if (!projected.wireStarted) return [];
          if (projected.item.type === "reasoning") {
            return [
              projectItem(projected.item, projected.outcome, this.#cwd),
              projectReasoningTranscriptItem(projected.item, projected.outcome, this.#cwd),
            ];
          }
          return projected.item.type === "agentMessage"
            ? [projectItem(projected.item, projected.outcome, this.#cwd)]
            : [];
        }),
      ],
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

  #projectInput(): JsonObject[] {
    return this.#input.length === 0
      ? []
      : [
          {
            id: `${this.#turnId}-user`,
            type: "userMessage",
            clientId: null,
            content: this.#input.map(({ text }) => ({ type: "text", text })),
          },
        ];
  }

  #startWireItem(projected: ProjectedItem, item: HostItem): JsonObject {
    if (projected.wireStarted) throw new Error("Codex Item started more than once");
    projected.wireStarted = true;
    this.#wireItemOrder.push(item.itemId);
    return {
      method: "item/started",
      emittedAtMs: this.#startedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs: this.#startedAtMs,
        item: projectItem(item, null, this.#cwd, true, this.#threadId),
      },
    };
  }

  #startReasoningTranscript(
    item: Extract<HostItem, { type: "reasoning" }>,
    emittedAtMs: number,
  ): JsonObject {
    return {
      method: "item/started",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        startedAtMs: this.#startedAtMs,
        item: projectReasoningTranscriptItem({ ...item, text: "" }, null, this.#cwd),
      },
    };
  }

  #reasoningOutputDelta(itemId: HostItemId, delta: string, emittedAtMs: number): JsonObject {
    return {
      method: "item/commandExecution/outputDelta",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        itemId,
        delta,
      },
    };
  }

  #reasoningDelta(projected: ProjectedItem, delta: string, emittedAtMs: number): JsonObject[] {
    if (projected.item.type !== "reasoning" || !projected.wireStarted) {
      throw new Error("Host Reasoning update precedes its Item start");
    }
    const messages: JsonObject[] = [];
    if (!projected.reasoningPartStarted) {
      projected.reasoningPartStarted = true;
      messages.push({
        method: "item/reasoning/summaryPartAdded",
        emittedAtMs,
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          itemId: reasoningPreviewItemId(projected.item.itemId),
          summaryIndex: 0,
        },
      });
    }
    messages.push({
      method: "item/reasoning/summaryTextDelta",
      emittedAtMs,
      params: {
        threadId: this.#threadId,
        turnId: this.#turnId,
        itemId: reasoningPreviewItemId(projected.item.itemId),
        delta,
        summaryIndex: 0,
      },
    });
    return messages;
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
