import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { OmpTurnEvent } from "./omp-rpc-session.js";

interface ActiveSubagentDelegation {
  item: HostSubagentDelegationItem;
}

export interface OmpSubagentLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

function subagentFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Omp Subagent delegation failed",
    retryable: false,
  };
}

export class OmpSubagentLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #delegations = new Map<string, ActiveSubagentDelegation>();

  constructor(options: OmpSubagentLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  get size(): number {
    return this.#delegations.size;
  }

  nativeSubagentId(callId: string): string | undefined {
    return this.#delegations.get(callId)?.item.subagents[0]?.nativeSubagentId;
  }

  start(
    turnId: HostTurnId,
    event: Extract<OmpTurnEvent, { type: "subagent.started" }>,
  ): HostSubagentState {
    if (this.#delegations.has(event.callId)) {
      throw new Error("Omp Subagent delegation started more than once");
    }
    const subagent: HostSubagentState = {
      subagentId: event.nativeSubagentId,
      nativeSubagentId: event.nativeSubagentId,
      description: event.description,
      ...(event.role ? { role: event.role } : {}),
      background: event.background,
      status: "running",
    };
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: "spawn",
      ...(event.prompt ? { prompt: event.prompt } : {}),
      subagents: [subagent],
    };
    this.#delegations.set(event.callId, { item });
    this.#emit({ type: "item.started", turnId, item });
    return subagent;
  }

  update(
    turnId: HostTurnId,
    event: Extract<OmpTurnEvent, { type: "subagent.updated" }>,
  ): HostSubagentState | undefined {
    const active = this.#delegations.get(event.callId);
    if (!active) return undefined;
    const current = active.item.subagents[0];
    if (!current) throw new Error("Omp Subagent delegation has no Agent state");
    const subagent: HostSubagentState = {
      ...current,
      status: event.status === "interrupted" ? "interrupted" : event.status,
      ...(event.description ? { description: event.description } : {}),
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
    };
    active.item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents: active.item.subagents },
    });
    return subagent;
  }

  complete(
    turnId: HostTurnId,
    event: Extract<OmpTurnEvent, { type: "subagent.completed" }>,
    cancellationRequested: boolean,
  ): HostSubagentState {
    const active = this.#delegations.get(event.callId);
    if (!active) throw new Error("Omp Subagent completion references an unknown delegation");
    this.#delegations.delete(event.callId);
    const current = active.item.subagents[0];
    if (!current) throw new Error("Omp Subagent delegation has no Agent state");
    const subagent: HostSubagentState = {
      ...current,
      status: cancellationRequested ? "interrupted" : event.isError ? "failed" : "completed",
      ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
      ...(event.nativeSubagentId ? { nativeSubagentId: event.nativeSubagentId } : {}),
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
    return subagent;
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
