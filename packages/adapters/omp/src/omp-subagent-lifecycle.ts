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

export interface OmpSubagentStartInput {
  callId: string;
  operation: "spawn" | "send";
  description: string;
  prompt?: string;
  role?: string;
  model?: string;
  reasoningEffort?: string;
  background: boolean;
  nativeSubagentId?: string;
  agents?: Array<{
    description: string;
    prompt?: string;
    role?: string;
    model?: string;
    reasoningEffort?: string;
    background?: boolean;
    nativeSubagentId?: string;
  }>;
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
  readonly #callIdByNativeId = new Map<string, string>();

  constructor(options: OmpSubagentLifecycleOptions) {
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

  start(turnId: HostTurnId, input: OmpSubagentStartInput): HostSubagentState {
    const agents = (input.agents && input.agents.length > 0 ? input.agents : [input]).map(
      (agent, index) => {
        const localId = index === 0 ? input.callId : `${input.callId}:${index}`;
        const nativeSubagentId = agent.nativeSubagentId;
        const background = agent.background ?? input.background;
        const state: HostSubagentState = {
          subagentId: nativeSubagentId ?? localId,
          ...(nativeSubagentId ? { nativeSubagentId } : {}),
          description: agent.description,
          ...(agent.role ? { role: agent.role } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
          background,
          status: "running" as const,
        };
        return state;
      },
    );
    const primary = agents[0];
    if (!primary) throw new Error("Omp Subagent delegation has no Agent state");
    const existing = this.#delegations.get(input.callId);
    if (existing) {
      return this.#replaceAgents(turnId, input.callId, existing, agents) ?? primary;
    }
    this.#bindCallIds(input.callId, agents);
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: input.operation,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      subagents: agents,
    };
    this.#delegations.set(input.callId, { callId: input.callId, item });
    this.#emit({ type: "item.started", turnId, item });
    for (const agent of agents) this.#emitState(agent);
    return primary;
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
      if (
        active.item.subagents.some((agent) => agent.nativeSubagentId === input.nativeSubagentId)
      ) {
        return this.update(turnId, callId, input);
      }
    }
    for (const [callId, active] of this.#delegations) {
      const unmatched = active.item.subagents.find(
        (agent) =>
          !agent.nativeSubagentId ||
          agent.nativeSubagentId === callId ||
          agent.nativeSubagentId.startsWith(`${callId}:`),
      );
      if (!unmatched) continue;
      if (input.description && unmatched.description === input.description) {
        return this.update(turnId, callId, input);
      }
    }
    for (const [callId, active] of this.#delegations) {
      const unmatched = active.item.subagents.find(
        (agent) =>
          !agent.nativeSubagentId ||
          agent.nativeSubagentId === callId ||
          agent.nativeSubagentId.startsWith(`${callId}:`),
      );
      if (unmatched) {
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
    const index = this.#agentIndex(active.item.subagents, patch.nativeSubagentId);
    const current = active.item.subagents[index];
    if (!current) throw new Error("Omp Subagent delegation has no Agent state");
    if (patch.nativeSubagentId) this.#callIdByNativeId.set(patch.nativeSubagentId, callId);
    const nativeSubagentId = patch.nativeSubagentId ?? current.nativeSubagentId;
    const subagent: HostSubagentState = {
      ...current,
      ...(nativeSubagentId
        ? { nativeSubagentId, subagentId: nativeSubagentId }
        : { subagentId: current.subagentId }),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.role ? { role: patch.role } : {}),
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.resultSummary ? { resultSummary: patch.resultSummary } : {}),
      ...(patch.status ? { status: patch.status } : {}),
    };
    const subagents = [...active.item.subagents];
    subagents[index] = subagent;
    active.item = { ...active.item, subagents };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents },
    });
    this.#emitState(subagent);
    return subagent;
  }

  completeSpawn(
    turnId: HostTurnId,
    callId: string,
    input: {
      nativeSubagentId?: string;
      nativeSubagentIds?: string[];
      failed: boolean;
      background?: boolean;
      resultSummary?: string;
      cancellationRequested: boolean;
    },
  ): HostSubagentState | undefined {
    const active = this.#delegations.get(callId);
    if (input.nativeSubagentIds && input.nativeSubagentIds.length > 0 && active) {
      this.#assignNativeIds(turnId, callId, active, input.nativeSubagentIds);
    }
    const background =
      input.background ?? active?.item.subagents.some((agent) => agent.background) ?? false;
    const keepRunning =
      !input.failed &&
      !input.cancellationRequested &&
      (background || active?.item.operation === "send");
    if (keepRunning) {
      if (active && active.item.subagents.length > 1 && !input.nativeSubagentId) {
        for (const agent of active.item.subagents) {
          this.update(turnId, callId, {
            status: "running",
            ...(agent.nativeSubagentId ? { nativeSubagentId: agent.nativeSubagentId } : {}),
          });
        }
        return active.item.subagents[0];
      }
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
    const status: HostSubagentStatus =
      input.status ??
      (input.cancellationRequested
        ? "interrupted"
        : input.failed
          ? "failed"
          : input.keepRunning
            ? "running"
            : "completed");
    const index = this.#agentIndex(active.item.subagents, input.nativeSubagentId);
    const current = active.item.subagents[index];
    if (!current) throw new Error("Omp Subagent delegation has no Agent state");
    const nativeSubagentId = input.nativeSubagentId ?? current.nativeSubagentId;
    if (nativeSubagentId) this.#callIdByNativeId.set(nativeSubagentId, callId);
    const subagent: HostSubagentState = {
      ...current,
      status,
      ...(nativeSubagentId ? { nativeSubagentId, subagentId: nativeSubagentId } : {}),
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
    };
    const subagents = [...active.item.subagents];
    subagents[index] = subagent;
    const remaining = subagents.some(
      (agent) => agent.status === "pending" || agent.status === "running",
    );
    const item = { ...active.item, subagents };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents },
    });
    this.#emitState(subagent);
    if (remaining) {
      active.item = item;
      return subagent;
    }
    this.#delegations.delete(callId);
    const outcome: HostItemOutcome = input.cancellationRequested
      ? { status: "cancelled", reason: "Cancelled by user" }
      : input.failed
        ? { status: "failed", error: subagentFailure() }
        : { status: "succeeded" };
    this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
    return subagent;
  }

  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const [callId, active] of this.#delegations) {
      this.#delegations.delete(callId);
      const subagents = active.item.subagents.map((current) => {
        const status: HostSubagentStatus =
          outcome.status === "succeeded"
            ? current.status === "running" || current.status === "pending"
              ? "completed"
              : current.status
            : outcome.status === "cancelled"
              ? "interrupted"
              : "failed";
        return { ...current, status };
      });
      const item = { ...active.item, subagents };
      this.#emit({ type: "item.completed", turnId, snapshot: { item, outcome } });
      for (const subagent of subagents) this.#emitState(subagent);
    }
  }

  #bindCallIds(callId: string, agents: HostSubagentState[]): void {
    this.#callIdByNativeId.set(callId, callId);
    for (const agent of agents) {
      if (agent.nativeSubagentId) this.#callIdByNativeId.set(agent.nativeSubagentId, callId);
    }
  }

  #replaceAgents(
    turnId: HostTurnId,
    callId: string,
    existing: ActiveSubagentDelegation,
    agents: HostSubagentState[],
  ): HostSubagentState | undefined {
    this.#bindCallIds(callId, agents);
    if (agents.length <= existing.item.subagents.length) {
      let updated: HostSubagentState | undefined;
      for (const agent of agents) {
        updated = this.update(turnId, callId, {
          ...(agent.nativeSubagentId ? { nativeSubagentId: agent.nativeSubagentId } : {}),
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.role ? { role: agent.role } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
        });
      }
      return updated ?? existing.item.subagents[0];
    }
    existing.item = { ...existing.item, subagents: agents };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: existing.item.itemId,
      update: { type: "subagents.replace", subagents: agents },
    });
    for (const agent of agents) this.#emitState(agent);
    return agents[0];
  }

  #assignNativeIds(
    turnId: HostTurnId,
    callId: string,
    active: ActiveSubagentDelegation,
    nativeSubagentIds: string[],
  ): void {
    const subagents = active.item.subagents.map((agent, index) => {
      const nativeSubagentId = nativeSubagentIds[index] ?? agent.nativeSubagentId;
      if (!nativeSubagentId) return agent;
      this.#callIdByNativeId.set(nativeSubagentId, callId);
      return { ...agent, nativeSubagentId, subagentId: nativeSubagentId };
    });
    active.item = { ...active.item, subagents };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: active.item.itemId,
      update: { type: "subagents.replace", subagents },
    });
    for (const agent of subagents) this.#emitState(agent);
  }

  #agentIndex(subagents: HostSubagentState[], nativeSubagentId?: string): number {
    if (nativeSubagentId) {
      const matched = subagents.findIndex((agent) => agent.nativeSubagentId === nativeSubagentId);
      if (matched >= 0) return matched;
    }
    const unmatched = subagents.findIndex((agent) => !agent.nativeSubagentId);
    if (unmatched >= 0) return unmatched;
    return 0;
  }

  #callIdForNative(nativeSubagentId: string): string | undefined {
    for (const [callId, active] of this.#delegations) {
      if (active.item.subagents.some((agent) => agent.nativeSubagentId === nativeSubagentId)) {
        return callId;
      }
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
