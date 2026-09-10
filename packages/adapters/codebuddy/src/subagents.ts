import type {
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostSubagentState,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import type { NativeSessionRef, HostTurnId } from "@codexhost/shared-contracts";
import { record, text } from "./common.js";
import { contentText } from "./projection.js";
import { codeBuddyChildId, codeBuddyDelegation } from "./subagent-tool.js";
import { locateCodeBuddyChild, readCodeBuddyChild } from "./subagent-history.js";
import { nativeModel } from "./configuration.js";

interface Delegation {
  turnId: HostTurnId;
  item: HostSubagentDelegationItem;
  done: boolean;
  requestId?: string;
  signature?: string;
}

/** Observe only registered native Agent calls. Child bodies come from native files, not a shadow transcript. */
export class CodeBuddySubagents {
  readonly #calls = new Map<string, Delegation>();
  #turnId: HostTurnId | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #refreshing = false;
  #closed = false;
  constructor(
    readonly options: {
      parent(): NativeSessionRef | undefined;
      cwd: string;
      environment: NodeJS.ProcessEnv;
      emit(event: HostEvent): void;
      locate?: typeof locateCodeBuddyChild;
      read?: typeof readCodeBuddyChild;
    },
  ) {}

  begin(turnId: HostTurnId) {
    this.#turnId = turnId;
  }
  state(id: string) {
    return [...this.#calls.values()]
      .map((call) => call.item.subagents[0])
      .findLast((child) => child?.nativeSubagentId === id);
  }
  project(snapshot: HostThreadSnapshot): HostThreadSnapshot {
    for (const turn of snapshot.turns)
      for (const { item } of turn.items)
        if (item.type === "subagentDelegation")
          item.subagents = item.subagents.map((child) =>
            child.nativeSubagentId ? (this.state(child.nativeSubagentId) ?? child) : child,
          );
    return snapshot;
  }

  update(value: unknown): boolean {
    const update = record(value),
      meta = record(update._meta);
    const parentCallId = text(meta["codebuddy.ai/parentToolCallId"]);
    if (parentCallId) {
      const call = this.#calls.get(parentCallId);
      if (call && !call.done) {
        const requestId = text(meta["codebuddy.ai/conversationRequestId"]);
        if (requestId) call.requestId = requestId;
        const progress =
          update.sessionUpdate === "tool_call" && meta["codebuddy.ai/toolArgumentsComplete"]
            ? text(update.title)
            : "";
        if (progress) this.#update(call, { resultSummary: progress.slice(0, 2000) });
        this.#watch();
      }
      return true;
    }
    const callId = text(update.toolCallId),
      name = text(meta["codebuddy.ai/toolName"]);
    let call = this.#calls.get(callId);
    if (!call && name !== "Agent" && meta["codebuddy.ai/isSubagent"] !== true) return false;
    if (!this.#turnId || this.#closed || call?.done) return true;
    if (!call) {
      if (!meta["codebuddy.ai/toolArgumentsComplete"]) return true;
      call = {
        turnId: this.#turnId,
        item: codeBuddyDelegation(callId, update.rawInput, "running"),
        done: false,
      };
      this.#calls.set(callId, call);
      this.options.emit({
        type: "item.started",
        turnId: call.turnId,
        item: structuredClone(call.item),
      });
      this.#watch();
    }
    if (update.status === "completed" || update.status === "failed") {
      const childId = codeBuddyChildId(update),
        child = call.item.subagents[0];
      this.#update(call, {
        ...(childId ? { nativeSubagentId: childId, subagentId: childId } : {}),
        status: update.status === "failed" ? "failed" : child?.background ? "running" : "completed",
        resultSummary: contentText(update.rawOutput ?? update.content).slice(0, 2000),
      });
      call.done = true;
      this.options.emit({
        type: "item.completed",
        turnId: call.turnId,
        snapshot: {
          item: structuredClone(call.item),
          outcome:
            update.status === "failed"
              ? {
                  status: "failed",
                  error: {
                    code: "nativeFailure",
                    message: "CodeBuddy Subagent invocation failed",
                    retryable: false,
                  },
                }
              : { status: "succeeded" },
        },
      });
      const id = call.item.subagents[0]?.nativeSubagentId;
      if (id) this.options.emit({ type: "subagent.transcript.changed", nativeSubagentId: id });
    }
    return true;
  }

  #update(call: Delegation, changes: Partial<HostSubagentState>) {
    const current = call.item.subagents[0];
    if (!current) return;
    const next = { ...current, ...changes };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    call.item = { ...call.item, subagents: [next] };
    if (!call.done)
      this.options.emit({
        type: "item.updated",
        turnId: call.turnId,
        itemId: call.item.itemId,
        update: { type: "subagents.replace", subagents: structuredClone(call.item.subagents) },
      });
    if (next.nativeSubagentId)
      this.options.emit({
        type: "subagent.state.changed",
        nativeSubagentId: next.nativeSubagentId,
        status: next.status,
        ...(next.resultSummary ? { resultSummary: next.resultSummary } : {}),
      });
  }

  #watch() {
    if (!this.#timer && !this.#closed) {
      this.#timer = setInterval(() => {
        void this.refresh();
      }, 750);
      this.#timer.unref();
      void this.refresh();
    }
  }

  async refresh() {
    if (this.#refreshing || this.#closed) return;
    const parent = this.options.parent();
    if (!parent) return;
    this.#refreshing = true;
    try {
      for (const call of this.#calls.values()) {
        if (call.done) continue;
        try {
          const id =
            call.item.subagents[0]?.nativeSubagentId ??
            (call.requestId
              ? await (this.options.locate ?? locateCodeBuddyChild)(
                  parent,
                  this.options.cwd,
                  this.options.environment,
                  call.requestId,
                )
              : undefined);
          if (!id || this.#closed || call.done) continue;
          if (!call.item.subagents[0]?.nativeSubagentId)
            this.#update(call, { nativeSubagentId: id, subagentId: id });
          const snapshot = await (this.options.read ?? readCodeBuddyChild)(
            parent,
            id,
            this.options.cwd,
            this.options.environment,
            "running",
          );
          if (this.#closed || call.done) continue;
          const observedModel = snapshot.turns.at(-1)?.model;
          if (observedModel) this.#update(call, { model: nativeModel(observedModel) });
          const signature = JSON.stringify(snapshot);
          if (signature !== call.signature) {
            call.signature = signature;
            this.options.emit({ type: "subagent.transcript.changed", nativeSubagentId: id });
          }
        } catch {
          /* An in-flight/missing transcript is not a native completion. */
        }
      }
    } finally {
      this.#refreshing = false;
    }
  }

  finish(outcome: HostItemOutcome) {
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const call of this.#calls.values()) {
      const child = call.item.subagents[0];
      if (call.turnId !== this.#turnId || !child || !["running", "pending"].includes(child.status))
        continue;
      this.#update(call, {
        status: "interrupted",
        resultSummary: "Parent Turn ended; native child completion was not confirmed",
      });
      if (!call.done) {
        call.done = true;
        this.options.emit({
          type: "item.completed",
          turnId: call.turnId,
          snapshot: { item: structuredClone(call.item), outcome },
        });
      }
    }
    this.#turnId = undefined;
  }
  close() {
    this.#closed = true;
    this.finish({ status: "cancelled", reason: "Session closed" });
  }
}
