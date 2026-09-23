import type {
  HarnessError,
  HarnessOutput,
  HarnessSessionState,
  HostEvent,
  HostInteraction,
  HostItem,
  HostItemSnapshot,
  HostItemUpdate,
  HostUsage,
} from "@codexhost/harness-adapter";

import type { DiagnosticLogFields, DiagnosticLogLevel } from "./diagnostic-log.js";

type LogSink = (level: DiagnosticLogLevel, event: string, fields?: DiagnosticLogFields) => void;

interface ItemTrace {
  startedAtMs: number;
  updates: number;
  appendedChars: number;
}

interface TurnTrace {
  startedAtMs: number;
  items: Record<string, number>;
}

/**
 * Records one External Thread as bounded metadata. Streaming deltas are counted, never
 * written, so a Turn costs one line per Item instead of one per chunk. No user, model,
 * tool, command, or file content crosses this boundary.
 */
export class ThreadEventLog {
  readonly #items = new Map<string, ItemTrace>();
  readonly #turns = new Map<string, TurnTrace>();
  #lastState: string | undefined;
  #lastUsage: HostUsage | null = null;

  constructor(
    readonly write: LogSink,
    private readonly now: () => number = Date.now,
  ) {}

  output(output: HarnessOutput): void {
    if (output.kind === "interaction") this.#interaction(output.interaction);
    else this.#event(output.event);
  }

  #event(event: HostEvent): void {
    switch (event.type) {
      case "session.state.changed":
        this.#state(event.state);
        return;
      case "session.usage.changed":
        this.#lastUsage = event.usage;
        this.write("debug", "session.usage.changed", {
          observedForTurnId: event.observedForTurnId,
          usage: usageFields(event.usage),
        });
        return;
      case "subagent.state.changed":
        this.write("info", "subagent.state.changed", {
          nativeSubagentId: event.nativeSubagentId,
          status: event.status,
          hasResultSummary: event.resultSummary !== undefined,
        });
        return;
      case "subagent.transcript.changed":
        this.write("debug", "subagent.transcript.changed", {
          nativeSubagentId: event.nativeSubagentId,
        });
        return;
      case "turn.started":
        this.#turns.set(event.turnId, { startedAtMs: this.now(), items: {} });
        this.write("info", "turn.started", { turnId: event.turnId });
        return;
      case "turn.autonomous.started":
        this.#turns.set(event.turnId, { startedAtMs: this.now(), items: {} });
        this.write("info", "turn.started", {
          turnId: event.turnId,
          autonomous: true,
          inputCount: event.input.length,
          inputChars: event.input.reduce((total, input) => total + input.text.length, 0),
        });
        return;
      case "item.started":
        this.#items.set(itemKey(event.turnId, event.item.itemId), {
          startedAtMs: this.now(),
          updates: 0,
          appendedChars: 0,
        });
        this.write("debug", "item.started", {
          turnId: event.turnId,
          itemId: event.item.itemId,
          itemType: event.item.type,
        });
        return;
      case "item.updated": {
        const trace = this.#items.get(itemKey(event.turnId, event.itemId));
        if (!trace) return;
        trace.updates += 1;
        trace.appendedChars += appendedChars(event.update);
        return;
      }
      case "item.completed":
        this.#itemCompleted(event.turnId, event.snapshot);
        return;
      case "interaction.closed":
        this.write("info", "interaction.closed", {
          turnId: event.turnId,
          interactionId: event.interactionId,
          reason: event.reason,
        });
        return;
      case "turn.completed": {
        const turn = this.#turns.get(event.turnId);
        this.#turns.delete(event.turnId);
        for (const key of this.#items.keys()) {
          if (key.startsWith(`${event.turnId}\u0000`)) this.#items.delete(key);
        }
        const outcome = event.outcome;
        this.write(outcome.status === "failed" ? "error" : "info", "turn.completed", {
          turnId: event.turnId,
          status: outcome.status,
          durationMs: turn ? this.now() - turn.startedAtMs : undefined,
          nativeTurnKey: event.nativeTurnRef?.nativeTurnKey,
          hasCheckpoint: outcome.checkpoint !== undefined,
          error: outcome.status === "failed" ? harnessErrorFields(outcome.error) : undefined,
          cancelReason: outcome.status === "cancelled" ? outcome.reason : undefined,
          items: turn?.items,
          usage: usageFields(this.#lastUsage),
        });
        return;
      }
      case "session.faulted":
        this.write("error", "session.faulted", { error: harnessErrorFields(event.error) });
        return;
    }
  }

  #state(state: HarnessSessionState): void {
    const fields = {
      nativeSessionId: state.nativeRef?.nativeSessionId,
      modelId: state.effectiveModel?.id,
      resolvedModelLabel: state.resolvedModelLabel,
      thinkingOptionId: state.effectiveThinkingOptionId,
      permissionModeId: state.effectivePermissionModeId,
    };
    const signature = JSON.stringify(fields);
    if (signature === this.#lastState) return;
    this.#lastState = signature;
    this.write("info", "session.state.changed", fields);
  }

  #itemCompleted(turnId: string, snapshot: HostItemSnapshot): void {
    const { item, outcome } = snapshot;
    const key = itemKey(turnId, item.itemId);
    const trace = this.#items.get(key);
    this.#items.delete(key);
    const turn = this.#turns.get(turnId);
    if (turn) turn.items[item.type] = (turn.items[item.type] ?? 0) + 1;
    this.write(outcome.status === "failed" ? "warn" : "info", "item.completed", {
      turnId,
      itemId: item.itemId,
      itemType: item.type,
      status: outcome.status,
      durationMs: itemDurationMs(item) ?? (trace ? this.now() - trace.startedAtMs : undefined),
      updates: trace?.updates,
      appendedChars: trace?.appendedChars,
      ...itemFields(item),
      error: outcome.status === "failed" ? harnessErrorFields(outcome.error) : undefined,
      cancelReason: outcome.status === "cancelled" ? outcome.reason : undefined,
    });
  }

  #interaction(interaction: HostInteraction): void {
    this.write("info", "interaction.opened", {
      turnId: interaction.turnId,
      interactionId: interaction.interactionId,
      interactionType: interaction.type,
      expires: interaction.expiresAt !== undefined,
      ...(interaction.type === "approval"
        ? { effects: interaction.actions.map((action) => action.effect) }
        : {
            questionCount: interaction.questions.length,
            questionTypes: interaction.questions.map((question) => question.type),
          }),
    });
  }
}

export function harnessErrorFields(error: HarnessError): DiagnosticLogFields {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    stage: error.stage,
    durationMs: error.durationMs,
    diagnostic: error.diagnostic,
    stderrTail: error.stderrTail,
  };
}

function itemKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
}

function appendedChars(update: HostItemUpdate): number {
  return update.type === "text.append" || update.type === "output.append" ? update.text.length : 0;
}

function itemDurationMs(item: HostItem): number | undefined {
  return item.type === "commandExecution" || item.type === "toolExecution"
    ? item.durationMs
    : undefined;
}

/** Shape and size only; text, commands, arguments, outputs, paths, and diffs stay out. */
function itemFields(item: HostItem): DiagnosticLogFields {
  switch (item.type) {
    case "agentMessage":
      return { textChars: item.text.length, phase: item.phase };
    case "reasoning":
      return { textChars: item.text.length };
    case "contextCompaction":
      return {};
    case "commandExecution":
      return {
        exitCode: item.exitCode,
        outputChars: item.output?.length,
        outputTruncated: item.outputTruncated,
      };
    case "toolExecution":
      return {
        toolName: item.toolName,
        namespace: item.namespace,
        outputParts: item.output?.content.length,
        outputTruncated: item.output?.truncated,
      };
    case "fileChange":
      return {
        fileCount: item.changes.length,
        changeKinds: item.changes.reduce<Record<string, number>>((counts, change) => {
          counts[change.kind] = (counts[change.kind] ?? 0) + 1;
          return counts;
        }, {}),
      };
    case "subagentDelegation":
      return {
        operation: item.operation,
        subagentStatuses: item.subagents.map((subagent) => subagent.status),
      };
  }
}

function usageFields(usage: HostUsage | null): DiagnosticLogFields | undefined {
  return usage ? { ...usage } : undefined;
}
