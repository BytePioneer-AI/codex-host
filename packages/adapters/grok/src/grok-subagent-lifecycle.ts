import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

interface ActiveSubagentDelegation {
  callId: string;
  item: HostSubagentDelegationItem;
}

export interface GrokSubagentStartInput {
  callId: string;
  operation: "spawn" | "send";
  description: string;
  prompt?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  background: boolean;
  nativeSubagentId?: string;
}

export interface GrokSubagentLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

function subagentFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Grok Subagent delegation failed",
    retryable: false,
  };
}

export class GrokSubagentLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #delegations = new Map<string, ActiveSubagentDelegation>();
  readonly #callIdByNativeId = new Map<string, string>();

  constructor(options: GrokSubagentLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  get size(): number {
    return this.#delegations.size;
  }

  has(callId: string): boolean {
    return this.#delegations.has(callId);
  }

  nativeSubagentId(callId: string): string | undefined {
    return this.#delegations.get(callId)?.item.subagents[0]?.nativeSubagentId;
  }

  start(turnId: HostTurnId, input: GrokSubagentStartInput): HostSubagentState {
    if (this.#delegations.has(input.callId)) {
      throw new Error("Grok Subagent delegation started more than once");
    }
    this.#callIdByNativeId.set(input.callId, input.callId);
    if (input.nativeSubagentId) this.#callIdByNativeId.set(input.nativeSubagentId, input.callId);
    const subagent: HostSubagentState = {
      subagentId: input.nativeSubagentId ?? input.callId,
      ...(input.nativeSubagentId ? { nativeSubagentId: input.nativeSubagentId } : {}),
      description: input.description,
      ...(input.role ? { role: input.role } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      background: input.background,
      status: "running",
    };
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: input.operation,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      subagents: [subagent],
    };
    this.#delegations.set(input.callId, { callId: input.callId, item });
    this.#emit({ type: "item.started", turnId, item });
    this.#emitState(subagent);
    return subagent;
  }

  bindNativeId(
    turnId: HostTurnId,
    input: {
      nativeSubagentId: string;
      description?: string;
      role?: string;
      model?: string;
    },
  ): HostSubagentState | undefined {
    for (const [callId, active] of this.#delegations) {
      const current = active.item.subagents[0];
      if (!current) continue;
      if (current.nativeSubagentId === input.nativeSubagentId) {
        return this.update(turnId, callId, input);
      }
    }
    for (const [callId, active] of this.#delegations) {
      const current = active.item.subagents[0];
      if (!current || current.nativeSubagentId) continue;
      if (input.description && current.description === input.description) {
        return this.update(turnId, callId, input);
      }
    }
    return undefined;
  }

  update(
    turnId: HostTurnId,
    callId: string,
    patch: {
      description?: string;
      role?: string;
      model?: string;
      reasoningEffort?: string;
      nativeSubagentId?: string;
      resultSummary?: string;
      status?: HostSubagentStatus;
    },
  ): HostSubagentState | undefined {
    const active = this.#delegations.get(callId);
    if (!active) return undefined;
    const current = active.item.subagents[0];
    if (!current) throw new Error("Grok Subagent delegation has no Agent state");
    if (patch.nativeSubagentId) this.#callIdByNativeId.set(patch.nativeSubagentId, callId);
    const nativeSubagentId = patch.nativeSubagentId ?? current.nativeSubagentId;
    const subagent: HostSubagentState = {
      ...current,
      ...(nativeSubagentId ? { nativeSubagentId, subagentId: nativeSubagentId } : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.role ? { role: patch.role } : {}),
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.resultSummary ? { resultSummary: patch.resultSummary } : {}),
      ...(patch.status ? { status: patch.status } : {}),
    };
    active.item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents: active.item.subagents },
    });
    this.#emitState(subagent);
    return subagent;
  }

  completeSpawn(
    turnId: HostTurnId,
    callId: string,
    input: {
      nativeSubagentId?: string;
      failed: boolean;
      background?: boolean;
      resultSummary?: string;
      cancellationRequested: boolean;
    },
  ): HostSubagentState | undefined {
    const active = this.#delegations.get(callId);
    const background = input.background ?? active?.item.subagents[0]?.background ?? true;
    const keepRunning =
      !input.failed &&
      !input.cancellationRequested &&
      (background || active?.item.operation === "send");
    if (keepRunning) {
      return this.update(turnId, callId, {
        status: "running",
        ...(input.nativeSubagentId ? { nativeSubagentId: input.nativeSubagentId } : {}),
        ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      });
    }
    return this.complete(turnId, callId, { ...input, keepRunning: false });
  }

  completeByNativeId(
    turnId: HostTurnId,
    nativeSubagentId: string,
    input: {
      failed: boolean;
      resultSummary?: string;
      cancellationRequested: boolean;
      status?: HostSubagentStatus;
    },
  ): HostSubagentState | undefined {
    const callId =
      this.#callIdByNativeId.get(nativeSubagentId) ?? this.#callIdForNative(nativeSubagentId);
    if (callId && this.#delegations.has(callId)) {
      return this.complete(turnId, callId, { ...input, nativeSubagentId });
    }
    const status =
      input.status ??
      (input.cancellationRequested ? "interrupted" : input.failed ? "failed" : "completed");
    this.#emit({
      type: "subagent.state.changed",
      nativeSubagentId,
      status,
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
    });
    return undefined;
  }

  complete(
    turnId: HostTurnId,
    callId: string,
    input: {
      nativeSubagentId?: string;
      failed: boolean;
      resultSummary?: string;
      cancellationRequested: boolean;
      keepRunning?: boolean;
      status?: HostSubagentStatus;
    },
  ): HostSubagentState | undefined {
    const active = this.#delegations.get(callId);
    if (!active) return undefined;
    this.#delegations.delete(callId);
    const current = active.item.subagents[0];
    if (!current) throw new Error("Grok Subagent delegation has no Agent state");
    const status: HostSubagentStatus =
      input.status ??
      (input.cancellationRequested
        ? "interrupted"
        : input.failed
          ? "failed"
          : input.keepRunning
            ? "running"
            : "completed");
    const nativeSubagentId = input.nativeSubagentId ?? current.nativeSubagentId;
    if (nativeSubagentId) this.#callIdByNativeId.set(nativeSubagentId, callId);
    const subagent: HostSubagentState = {
      ...current,
      status,
      ...(nativeSubagentId ? { nativeSubagentId, subagentId: nativeSubagentId } : {}),
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
    };
    const item = { ...active.item, subagents: [subagent] };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: item.subagents },
    });
    const outcome: HostItemOutcome = input.cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : input.failed
        ? { status: "failed", error: subagentFailure() }
        : { status: "succeeded" };
    this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
    this.#emitState(subagent);
    return subagent;
  }

  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const [callId, active] of this.#delegations) {
      this.#delegations.delete(callId);
      const current = active.item.subagents[0];
      if (!current) continue;
      const status: HostSubagentStatus =
        outcome.status === "succeeded"
          ? current.status
          : outcome.status === "cancelled"
            ? "interrupted"
            : "failed";
      const item = { ...active.item, subagents: [{ ...current, status }] };
      this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
      this.#emitState({ ...current, status });
    }
  }

  #callIdForNative(nativeSubagentId: string): string | undefined {
    for (const [callId, active] of this.#delegations) {
      if (active.item.subagents[0]?.nativeSubagentId === nativeSubagentId) return callId;
    }
    return undefined;
  }

  #emitState(subagent: HostSubagentState): void {
    if (!subagent.nativeSubagentId) return;
    this.#emit({
      type: "subagent.state.changed",
      nativeSubagentId: subagent.nativeSubagentId,
      status: subagent.status,
      ...(subagent.resultSummary ? { resultSummary: subagent.resultSummary } : {}),
    });
  }
}
