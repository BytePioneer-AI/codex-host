import { randomUUID } from "node:crypto";

import type {
  HostEvent,
  HostItem,
  HostItemOutcome,
  HostItemSnapshot,
  HostSubagentDelegationItem,
  HostSubagentState,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import { z } from "zod";

import type { AntigravityStepUpdateEvent } from "./stream-events.js";
import {
  nativeSubagentIdSchema,
  readSubagentTranscript,
  subagentRpc,
  subagentRunStatus,
} from "./subagent-transcript.js";

const infoSchema = z.object({
  subagents: z
    .array(
      z.object({
        conversation_id: nativeSubagentIdSchema,
        type_name: z.string().max(256).optional(),
        role: z.string().max(2048).optional(),
        initial_prompt: z.string().max(128_000).optional(),
      }),
    )
    .max(32),
});

interface Delegation {
  item: HostSubagentDelegationItem;
  completed: boolean;
}

interface SubagentOptions {
  turnId: HostTurnId;
  parentId(): string | undefined;
  port(): Promise<number | null>;
  cwd: string;
  outputLimit: number;
  initialStates?: HostSubagentState[];
  emit(event: HostEvent): void;
  complete(snapshot: HostItemSnapshot): void;
  schedule(work: () => Promise<void>): void;
}

export class AntigravitySubagents {
  readonly #states = new Map<string, HostSubagentState>();
  readonly #transcripts = new Map<string, string>();
  readonly #items = new Map<number, Delegation>();
  readonly #options: SubagentOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  #queued = false;
  #ended = false;
  #stopped = false;
  #cancellation: Promise<void> | undefined;
  #settled: (() => void) | undefined;
  readonly settled = new Promise<void>((resolve) => {
    this.#settled = resolve;
  });

  constructor(options: SubagentOptions) {
    this.#options = options;
    for (const state of options.initialStates ?? []) {
      if (state.nativeSubagentId) this.#states.set(state.nativeSubagentId, { ...state });
    }
    if (this.#states.size > 0) this.#watch();
  }

  get running(): boolean {
    return [...this.#states.values()].some(
      ({ status }) => status === "pending" || status === "running",
    );
  }

  state(id: string): HostSubagentState | undefined {
    return this.#states.get(id);
  }

  snapshot(item: HostItem): HostItem {
    return item.type === "subagentDelegation"
      ? {
          ...item,
          subagents: item.subagents.map(
            (subagent) => this.#states.get(subagent.nativeSubagentId ?? "") ?? subagent,
          ),
        }
      : item;
  }

  handle(step: AntigravityStepUpdateEvent["step_update"]): boolean {
    if (step.step_type !== "subagent") return false;
    if (this.#stopped) return true;
    let delegation = this.#items.get(step.step_index);
    if (delegation?.completed) return true;
    if (!delegation) {
      const parsed = infoSchema.safeParse(step.subagent_info);
      if (!parsed.success || parsed.data.subagents.length === 0) {
        if (step.state === "ERROR") return false;
        return true;
      }
      const subagents = parsed.data.subagents.map((child): HostSubagentState => {
        const state: HostSubagentState = {
          subagentId: child.conversation_id,
          nativeSubagentId: child.conversation_id,
          description: child.role || child.type_name || "Antigravity Subagent",
          ...(child.type_name ? { role: child.type_name } : {}),
          background: true,
          status: "running",
        };
        this.#states.set(child.conversation_id, state);
        return state;
      });
      delegation = {
        item: {
          type: "subagentDelegation",
          itemId: hostItemIdSchema.parse(randomUUID()),
          operation: "spawn",
          prompt: parsed.data.subagents.map((child) => child.initial_prompt ?? "").join("\n"),
          subagents,
        },
        completed: false,
      };
      this.#items.set(step.step_index, delegation);
      this.#options.emit({
        type: "item.started",
        turnId: this.#options.turnId,
        item: delegation.item,
      });
      this.#watch();
    }
    if (step.state === "DONE" || step.state === "ERROR") {
      this.#complete(
        delegation,
        step.state === "ERROR"
          ? {
              status: "failed",
              error: {
                code: "nativeFailure",
                message: "Subagent invocation failed",
                retryable: false,
              },
            }
          : { status: "succeeded" },
      );
    }
    return true;
  }

  async refresh(): Promise<void> {
    if (this.#stopped) return;
    const parentId = this.#options.parentId();
    const port = await this.#options.port();
    if (!parentId || port === null) return;
    for (const [id, previous] of this.#states) {
      if (this.#stopped) return;
      let status = previous.status;
      try {
        const value = await subagentRpc(port, id, "GetCascadeTrajectory");
        const observed = subagentRunStatus(value, parentId);
        // Idle is also the state of a cancelled child. Only a new running observation
        // can reactivate it; do not turn yesterday's cancellation into today's success.
        if (observed !== "completed" || (status !== "interrupted" && status !== "failed")) {
          status = observed ?? status;
        }
      } catch {
        // A transient read failure is not evidence that the native child finished.
      }
      const transcript = await readSubagentTranscript({
        parentId,
        childId: id,
        status,
        cwd: this.#options.cwd,
        outputLimit: this.#options.outputLimit,
      });
      if (this.#stopped) return;
      const last = transcript.ok
        ? transcript.value.turns.at(-1)?.items.findLast(({ item }) => item.type === "agentMessage")
            ?.item
        : undefined;
      const resultSummary =
        last?.type === "agentMessage" ? last.text.slice(0, 2000) : previous.resultSummary;
      const next = { ...previous, status, ...(resultSummary ? { resultSummary } : {}) };
      if (status !== previous.status || resultSummary !== previous.resultSummary) {
        this.#states.set(id, next);
        this.#options.emit({
          type: "subagent.state.changed",
          nativeSubagentId: id,
          status,
          ...(resultSummary ? { resultSummary } : {}),
        });
      }
      if (transcript.ok) {
        const content = JSON.stringify(transcript.value);
        if (content !== this.#transcripts.get(id)) {
          this.#transcripts.set(id, content);
          this.#options.emit({ type: "subagent.transcript.changed", nativeSubagentId: id });
        }
      }
    }
    if (this.#ended && !this.running) this.stop();
  }

  finish(outcome: HostItemOutcome): void {
    for (const delegation of this.#items.values()) {
      if (!delegation.completed) this.#complete(delegation, outcome);
    }
    this.#ended = true;
    if (!this.running) this.stop();
  }

  cancel(): Promise<void> {
    return (this.#cancellation ??= this.#cancelNative());
  }

  async #cancelNative(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    const port = await this.#options.port();
    const parentId = this.#options.parentId();
    // Stop the parent generator before cancelling children so it cannot schedule
    // another child between the cancellation request and process shutdown.
    if (port !== null && parentId && this.#states.size > 0) {
      await subagentRpc(port, parentId, "CancelCascadeInvocation").catch(() => undefined);
    }
    for (const [id, state] of this.#states) {
      let confirmed = false;
      let wasRunning = state.status === "running" || state.status === "pending";
      try {
        if (port !== null && parentId) {
          const value = await subagentRpc(port, id, "GetCascadeTrajectory");
          const observed = subagentRunStatus(value, parentId);
          wasRunning ||= observed === "running";
          if (!wasRunning) continue;
          if (observed !== null) {
            if (observed === "running") {
              await subagentRpc(port, id, "CancelCascadeInvocation");
              const final = await subagentRpc(port, id, "GetCascadeTrajectory");
              const finalStatus = subagentRunStatus(final, parentId);
              confirmed = finalStatus === "completed" || finalStatus === "failed";
            } else {
              confirmed = true;
            }
          }
        }
      } catch {
        // Report loss of observation distinctly from a confirmed native cancellation.
      }
      if (!wasRunning) continue;
      const resultSummary = confirmed
        ? "Cancelled by user"
        : "Observation interrupted; native Subagent cancellation could not be confirmed.";
      this.#states.set(id, { ...state, status: "interrupted", resultSummary });
      this.#options.emit({
        type: "subagent.state.changed",
        nativeSubagentId: id,
        status: "interrupted",
        resultSummary,
      });
      this.#options.emit({ type: "subagent.transcript.changed", nativeSubagentId: id });
    }
    this.stop();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#settled?.();
  }

  #watch(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#queued || this.#stopped) return;
      this.#queued = true;
      this.#options.schedule(async () => {
        try {
          await this.refresh();
        } finally {
          this.#queued = false;
        }
      });
    }, 750);
    this.#timer.unref();
  }

  #complete(delegation: Delegation, outcome: HostItemOutcome): void {
    delegation.completed = true;
    const item = this.snapshot(delegation.item);
    const snapshot = { item, outcome };
    this.#options.complete(snapshot);
    this.#options.emit({ type: "item.completed", turnId: this.#options.turnId, snapshot });
  }
}
