import type {
  HostEvent,
  HostItemOutcome,
  HostSubagentDelegationItem,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  nativeTurnRefSchema,
  type HostTurnId,
} from "@codexhost/shared-contracts";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" ? v : "");

// session/load rewrites toolCallId to replay-N-M. Address the native Task by
// verified parent Turn position, Task position and input fingerprint instead.
// Native Turn history is append-only for this adapter (fork/rollback unsupported).
export function cursorTaskHandle(turnIndex: number, taskIndex: number, input: unknown) {
  const args = obj(input);
  const digest = createHash("sha256")
    .update(JSON.stringify([str(args.description), str(args.prompt)]))
    .digest("hex")
    .slice(0, 24);
  const handle = `task.v1.${turnIndex}.${taskIndex}.${digest}`;
  cursorTaskAddress(handle);
  return handle;
}
export function cursorTaskAddress(handle: string) {
  const match = /^task\.v1\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.([a-f0-9]{24})$/u.exec(
    handle,
  );
  if (!match) throw new Error("Invalid Cursor Subagent handle");
  return { turnIndex: Number(match[1]), taskIndex: Number(match[2]) };
}

function role(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const fields = Object.keys(obj(value));
  return fields.length === 1 ? fields[0] : undefined;
}
export function cursorDelegation(nativeId: string, input: unknown): HostSubagentDelegationItem {
  const args = obj(input),
    name = role(args.subagentType);
  return {
    type: "subagentDelegation",
    itemId: hostItemIdSchema.parse(`cursor-${nativeId}`),
    operation: str(args.agentId) ? "send" : "spawn",
    ...(str(args.prompt) ? { prompt: str(args.prompt) } : {}),
    subagents: [
      {
        subagentId: nativeId,
        nativeSubagentId: nativeId,
        description: str(args.description) || "Cursor Subagent",
        ...(name ? { role: name } : {}),
        ...(str(args.model) ? { model: str(args.model) } : {}),
        background: false,
        status: "running",
      },
    ],
  };
}

interface Task {
  item: HostSubagentDelegationItem;
  terminal?: HostItemOutcome;
  done: boolean;
  output?: string;
}
export class CursorSubagents {
  readonly #tasks = new Map<string, Task>();
  constructor(
    readonly turnId: HostTurnId,
    readonly emit: (event: HostEvent) => void,
    readonly nativeTurnIndex = 0,
  ) {}
  update({ update }: SessionNotification): boolean {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
      return false;
    const args = obj(update.rawInput),
      callId = update.toolCallId;
    let task = this.#tasks.get(callId);
    if (!task && args._toolName !== "task") return false;
    if (task?.done) return true;
    if (!task) {
      task = {
        item: cursorDelegation(
          cursorTaskHandle(this.nativeTurnIndex, this.#tasks.size, args),
          args,
        ),
        done: false,
      };
      this.#tasks.set(callId, task);
      this.emit({ type: "item.started", turnId: this.turnId, item: structuredClone(task.item) });
    }
    const child = task.item.subagents[0];
    if (child && typeof obj(update.rawOutput).isBackground === "boolean")
      child.background = obj(update.rawOutput).isBackground === true;
    const body = update.content
      ?.flatMap((content) =>
        content.type === "content" && content.content.type === "text" ? [content.content.text] : [],
      )
      .join("\n");
    if (body) task.output = body;
    if (update.status === "failed") {
      task.terminal = {
        status: "failed",
        error: { code: "nativeFailure", message: "Cursor Subagent failed", retryable: false },
      };
      this.#complete(task);
    }
    if (update.status === "completed") task.terminal = { status: "succeeded" };
    return true;
  }
  extension(method: string, params: Record<string, unknown>): Record<string, unknown> | undefined {
    if (method !== "cursor/task") return undefined;
    const task = this.#tasks.get(str(params.toolCallId));
    if (!task) return { outcome: { outcome: "rejected", reason: "Unknown native Task call" } };
    if (!task.terminal)
      return { outcome: { outcome: "rejected", reason: "Native Task has not completed" } };
    const child = task.item.subagents[0];
    if (child && !task.done) {
      if (str(params.model)) child.model = str(params.model);
      this.#complete(task);
    }
    return {
      outcome: {
        outcome: "completed",
        ...(str(params.agentId) ? { agentId: str(params.agentId) } : {}),
        ...(typeof params.durationMs === "number" ? { durationMs: params.durationMs } : {}),
      },
    };
  }
  #complete(task: Task) {
    if (task.done || !task.terminal) return;
    const child = task.item.subagents[0];
    if (!child) return;
    child.status =
      task.terminal.status === "failed"
        ? "failed"
        : task.terminal.status === "cancelled"
          ? "interrupted"
          : child.background
            ? "running"
            : "completed";
    if (task.output) child.resultSummary = task.output.slice(0, 2000);
    this.emit({
      type: "item.updated",
      turnId: this.turnId,
      itemId: task.item.itemId,
      update: { type: "subagents.replace", subagents: structuredClone(task.item.subagents) },
    });
    this.emit({
      type: "subagent.state.changed",
      nativeSubagentId: child.nativeSubagentId ?? child.subagentId,
      status: child.status,
      ...(child.resultSummary ? { resultSummary: child.resultSummary } : {}),
    });
    this.emit({
      type: "subagent.transcript.changed",
      nativeSubagentId: child.nativeSubagentId ?? child.subagentId,
    });
    this.emit({
      type: "item.completed",
      turnId: this.turnId,
      snapshot: { item: structuredClone(task.item), outcome: task.terminal },
    });
    task.done = true;
  }
  finish(outcome: HostItemOutcome) {
    for (const task of this.#tasks.values()) {
      task.terminal ??=
        outcome.status === "succeeded"
          ? { status: "cancelled", reason: "Native Task completion unavailable" }
          : outcome;
      this.#complete(task);
      const child = task.item.subagents[0];
      if (child?.status === "running") {
        child.status = "interrupted";
        child.resultSummary =
          "Parent Turn ended; native background child completion was not confirmed";
        this.emit({
          type: "subagent.state.changed",
          nativeSubagentId: child.nativeSubagentId ?? child.subagentId,
          status: "interrupted",
          resultSummary: child.resultSummary,
        });
      }
    }
  }
  snapshot(parentId: string, handle: string): HostThreadSnapshot {
    const task = [...this.#tasks.values()].find(
      (task) => task.item.subagents[0]?.nativeSubagentId === handle,
    );
    if (!task) throw new Error("Native Cursor Task not found in this parent");
    return cursorChildSnapshot(parentId, task.item, task.terminal, task.output);
  }
}

export function cursorChildSnapshot(
  parentId: string,
  item: HostSubagentDelegationItem,
  terminal?: HostItemOutcome,
  output?: string,
): HostThreadSnapshot {
  const task = { item, terminal, output };
  const child = task.item.subagents[0];
  const handle = child?.nativeSubagentId;
  if (!handle) throw new Error("Missing native Cursor Task handle");
  cursorTaskAddress(handle);
  return {
    turns: [
      {
        nativeTurnRef: nativeTurnRefSchema.parse({
          harnessId: "cursor-cli",
          nativeSessionId: parentId,
          nativeTurnKey: handle,
          formatVersion: 1,
        }),
        input: task.item.prompt ? [{ type: "text", text: task.item.prompt }] : [],
        items: task.output
          ? [
              {
                item: {
                  type: "agentMessage",
                  itemId: hostItemIdSchema.parse(`cursor-task-result-${handle}`),
                  text: task.output,
                },
                outcome: task.terminal ?? { status: "succeeded" },
              },
            ]
          : [],
        outcome:
          child?.status === "running"
            ? {
                status: "unknown",
                reason:
                  "Cursor native Task is running; ACP does not expose its internal step stream",
              }
            : child?.status === "interrupted"
              ? {
                  status: "cancelled",
                  reason: child.resultSummary ?? "Subagent observation interrupted",
                }
              : (task.terminal ?? {
                  status: "unknown",
                  reason: "Native Task completion unavailable",
                }),
      },
    ],
  };
}
