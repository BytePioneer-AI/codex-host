import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { ClaudeTurnEvent } from "./transport.js";

interface ActiveSubagentDelegation {
  item: HostSubagentDelegationItem;
}

export interface ClaudeSubagentLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

function subagentFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Claude Code Subagent delegation failed",
    retryable: false,
  };
}

export class ClaudeSubagentLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #delegations = new Map<string, ActiveSubagentDelegation>();

  constructor(options: ClaudeSubagentLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  get size(): number {
    return this.#delegations.size;
  }

  nativeSubagentId(callId: string): string | undefined {
    return this.#delegations.get(callId)?.item.subagents[0]?.nativeSubagentId;
  }

  start(turnId: HostTurnId, event: Extract<ClaudeTurnEvent, { type: "subagent.started" }>): void {
    if (this.#delegations.has(event.callId)) {
      throw new Error("Claude Code Subagent delegation started more than once");
    }
    const subagent: HostSubagentState = {
      subagentId: event.nativeSubagentId ?? event.callId,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      description: event.description,
      ...(event.role ? { role: event.role } : {}),
      background: event.background,
      status: "running",
    };
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: event.operation,
      subagents: [subagent],
    };
    this.#delegations.set(event.callId, { item });
    this.#emit({ type: "item.started", turnId, item });
  }

  update(turnId: HostTurnId, event: Extract<ClaudeTurnEvent, { type: "subagent.updated" }>): void {
    const active = this.#delegations.get(event.callId);
    if (!active) return;
    const current = active.item.subagents[0];
    if (!current) throw new Error("Claude Code Subagent delegation has no Agent state");
    const subagent: HostSubagentState = {
      ...current,
      status: event.status,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.description ? { description: event.description } : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    };
    active.item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents: active.item.subagents },
    });
  }

  complete(
    turnId: HostTurnId,
    event: Extract<ClaudeTurnEvent, { type: "subagent.completed" }>,
    cancellationRequested: boolean,
  ): void {
    const active = this.#delegations.get(event.callId);
    if (!active)
      throw new Error("Claude Code Subagent completion references an unknown delegation");
    this.#delegations.delete(event.callId);
    const current = active.item.subagents[0];
    if (!current) throw new Error("Claude Code Subagent delegation has no Agent state");
    const status = cancellationRequested
      ? "interrupted"
      : event.isError
        ? "failed"
        : active.item.operation === "send" || event.continuesInBackground
          ? "running"
          : "completed";
    const subagent: HostSubagentState = {
      ...current,
      status,
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
    };
    const item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: item.subagents },
    });
    const outcome: HostItemOutcome = cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : event.isError
        ? { status: "failed", error: subagentFailure() }
        : { status: "succeeded" };
    this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
  }

  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const [callId, active] of this.#delegations) {
      this.#delegations.delete(callId);
      const current = active.item.subagents[0];
      if (!current) continue;
      const status =
        outcome.status === "succeeded"
          ? current.status
          : outcome.status === "cancelled"
            ? "interrupted"
            : "failed";
      const item = { ...active.item, subagents: [{ ...current, status }] };
      this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
    }
  }
}
