import type {
  HarnessError,
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostSubagentStatus,
} from "@codexhost/harness-adapter";
import type { HostItemId, HostTurnId } from "@codexhost/shared-contracts";

import type { ClaudeTurnEvent, ClaudeWorkflowAgent } from "./transport.js";

type WorkflowEvent<T extends ClaudeTurnEvent["type"]> = Extract<ClaudeTurnEvent, { type: T }>;

interface WorkflowRun {
  callId: string;
  name?: string;
  description?: string;
  taskId?: string;
  /** Opens with the first native task frame, which names the run. */
  item: HostSubagentDelegationItem | null;
  agents: Map<number, HostSubagentState>;
  /** The Workflow tool returned and the run keeps working in the background. */
  launched: boolean;
}

export interface ClaudeWorkflowLifecycleOptions {
  newItemId(): HostItemId;
  emit(event: HostEvent): void;
}

export interface ClaudeWorkflowSettlement {
  callId: string;
  taskId?: string;
  /** Agents whose native transcript may have changed. */
  nativeSubagentIds: string[];
}

function workflowFailure(): HarnessError {
  return {
    code: "nativeFailure",
    message: "Claude Code Workflow failed",
    retryable: false,
  };
}

function agentStatus(state: ClaudeWorkflowAgent["state"]): HostSubagentStatus {
  switch (state) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "done":
      return "completed";
    case "error":
      return "failed";
  }
}

function agentSnapshot(
  callId: string,
  agent: ClaudeWorkflowAgent,
  previous: HostSubagentState | undefined,
): HostSubagentState {
  const nativeSubagentId = agent.agentId ?? previous?.nativeSubagentId;
  const role = agent.agentType ?? agent.phaseTitle ?? previous?.role;
  const model = agent.model ?? previous?.model;
  const resultSummary =
    agent.state === "error"
      ? (agent.error ?? agent.resultPreview)
      : agent.state === "done"
        ? agent.resultPreview
        : undefined;
  return {
    // Stable before Claude Code assigns the agent ID; the run calls agents by ordinal.
    subagentId: `${callId}:${agent.index}`,
    ...(nativeSubagentId ? { nativeSubagentId } : {}),
    description: agent.label,
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    background: true,
    status: agentStatus(agent.state),
    ...(resultSummary ? { resultSummary } : {}),
  };
}

function sameAgent(left: HostSubagentState | undefined, right: HostSubagentState): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Projects native Workflow runs onto the common Subagent contract: one delegation Item per
 * run, one Subagent per workflow agent. A launched run stays open after the Workflow tool
 * returns, because its agents only appear while it runs in the background.
 */
export class ClaudeWorkflowLifecycle {
  readonly #emit: (event: HostEvent) => void;
  readonly #newItemId: () => HostItemId;
  readonly #runs = new Map<string, WorkflowRun>();

  constructor(options: ClaudeWorkflowLifecycleOptions) {
    this.#emit = options.emit;
    this.#newItemId = options.newItemId;
  }

  /** Runs whose Workflow tool has not returned yet. */
  get pendingCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) if (!run.launched) count += 1;
    return count;
  }

  /** Native task IDs of launched runs still open. */
  taskIds(): string[] {
    return [...this.#runs.values()].flatMap((run) =>
      run.launched && run.taskId ? [run.taskId] : [],
    );
  }

  start(event: WorkflowEvent<"workflow.started">): void {
    if (this.#runs.has(event.callId)) {
      throw new Error("Claude Code Workflow started more than once");
    }
    this.#runs.set(event.callId, {
      callId: event.callId,
      ...(event.name ? { name: event.name } : {}),
      item: null,
      agents: new Map(),
      launched: false,
    });
  }

  /** Returns agents whose state changed, so their transcripts can be refreshed. */
  update(turnId: HostTurnId, event: WorkflowEvent<"workflow.updated">): string[] {
    const run = this.#runs.get(event.callId);
    if (!run) return [];
    if (event.taskId) run.taskId = event.taskId;
    if (event.description && !run.item) run.description = event.description;
    const changed: HostSubagentState[] = [];
    for (const agent of event.agents ?? []) {
      const previous = run.agents.get(agent.index);
      const next = agentSnapshot(run.callId, agent, previous);
      if (sameAgent(previous, next)) continue;
      run.agents.set(agent.index, next);
      changed.push(next);
    }
    if (!run.item) {
      this.#open(turnId, run);
    } else if (changed.length > 0) {
      this.#replaceSubagents(turnId, run);
    }
    return changed.flatMap((agent) => (agent.nativeSubagentId ? [agent.nativeSubagentId] : []));
  }

  /** Running agents of the run, whose transcripts an activity frame may have changed. */
  activity(callId: string): string[] {
    const run = this.#runs.get(callId);
    if (!run) return [];
    return [...run.agents.values()].flatMap((agent) =>
      agent.status === "running" && agent.nativeSubagentId ? [agent.nativeSubagentId] : [],
    );
  }

  /** Returns the launched run, or null when the tool result settled the Item. */
  launched(
    turnId: HostTurnId,
    event: WorkflowEvent<"workflow.launched">,
    cancellationRequested: boolean,
  ): { callId: string; taskId?: string } | null {
    const run = this.#runs.get(event.callId);
    if (!run) return null;
    if (event.taskId) run.taskId = event.taskId;
    if (!run.item) this.#open(turnId, run);
    if (event.background && !cancellationRequested) {
      run.launched = true;
      return { callId: run.callId, ...(run.taskId ? { taskId: run.taskId } : {}) };
    }
    this.#complete(
      turnId,
      run,
      cancellationRequested
        ? { status: "cancelled", reason: "Cancelled by user" }
        : event.isError
          ? { status: "failed", error: workflowFailure() }
          : { status: "succeeded" },
    );
    return null;
  }

  /** Settles the run a native task notification names; null when it is not a Workflow run. */
  settle(
    turnId: HostTurnId,
    event: WorkflowEvent<"subagent.settled">,
  ): ClaudeWorkflowSettlement | null {
    const run =
      (event.callId ? this.#runs.get(event.callId) : undefined) ??
      [...this.#runs.values()].find((candidate) => candidate.taskId === event.nativeSubagentId);
    if (!run) return null;
    const nativeSubagentIds = [...run.agents.values()].flatMap((agent) =>
      agent.nativeSubagentId ? [agent.nativeSubagentId] : [],
    );
    this.#complete(
      turnId,
      run,
      event.status === "completed"
        ? { status: "succeeded" }
        : event.status === "failed"
          ? { status: "failed", error: workflowFailure() }
          : { status: "cancelled", reason: "Workflow stopped" },
    );
    return {
      callId: run.callId,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      nativeSubagentIds,
    };
  }

  /** Settles every open run with the Turn outcome. */
  finalize(turnId: HostTurnId, outcome: HostItemOutcome): void {
    for (const run of [...this.#runs.values()]) {
      if (!run.item) {
        // The tool never reached Claude Code's Workflow runtime, so there is no run to show.
        this.#runs.delete(run.callId);
        continue;
      }
      this.#complete(turnId, run, outcome);
    }
  }

  #open(turnId: HostTurnId, run: WorkflowRun): void {
    const prompt = run.description ?? run.name;
    const item: HostSubagentDelegationItem = {
      type: "subagentDelegation",
      itemId: this.#newItemId(),
      operation: "spawn",
      ...(prompt ? { prompt } : {}),
      subagents: this.#orderedAgents(run),
    };
    run.item = item;
    this.#emit({ type: "item.started", turnId, item });
  }

  #replaceSubagents(turnId: HostTurnId, run: WorkflowRun): void {
    const item = run.item;
    if (!item) return;
    run.item = { ...item, subagents: this.#orderedAgents(run) };
    this.#emit({
      type: "item.updated",
      turnId,
      itemId: item.itemId,
      update: { type: "subagents.replace", subagents: run.item.subagents },
    });
  }

  #complete(turnId: HostTurnId, run: WorkflowRun, outcome: HostItemOutcome): void {
    this.#runs.delete(run.callId);
    const item = run.item;
    if (!item) return;
    // Agents the last progress frame left unfinished end with the run; a queued agent that
    // never started did not run at all.
    const running: HostSubagentStatus =
      outcome.status === "succeeded"
        ? "completed"
        : outcome.status === "cancelled"
          ? "interrupted"
          : "failed";
    const subagents = this.#orderedAgents(run).map((agent) =>
      agent.status === "running"
        ? { ...agent, status: running }
        : agent.status === "pending"
          ? { ...agent, status: "interrupted" as const }
          : agent,
    );
    this.#emit({
      type: "item.completed",
      turnId,
      snapshot: { item: { ...item, subagents }, outcome },
    });
  }

  #orderedAgents(run: WorkflowRun): HostSubagentState[] {
    return [...run.agents.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, agent]) => agent);
  }
}
