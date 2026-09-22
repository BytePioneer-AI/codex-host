import { open } from "node:fs/promises";

import type {
  HostBackgroundTask,
  HostBackgroundTaskStatus,
  HostThreadSnapshot,
} from "@codexhost/harness-adapter";
import { hostItemIdSchema, type NativeSessionRef } from "@codexhost/shared-contracts";

/**
 * Observed facts for one native background command. Each field comes only from
 * its native source: the command from the Bash tool input, the output file from
 * the native tool result or task notification, the summary from the notification.
 */
export interface ClaudeBackgroundCommand {
  task: HostBackgroundTask;
  command?: string;
  outputFile?: string;
  summary?: string;
}

const BACKGROUND_TASK_TYPE = "local_bash";
const ID_LIMIT = 1_024;
const PATH_LIMIT = 16_384;
const COMMAND_LIMIT = 65_536;
const DESCRIPTION_LIMIT = 1_024;
/** Claude CLI 2.1.273 Bash result text; the running tool result carries no structured path. */
const OUTPUT_FILE_PATTERN = /Output is being written to: (.+?\.output)\./u;

const NOTIFICATION_STATUS: Record<string, HostBackgroundTaskStatus> = {
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};
const UPDATED_STATUS: Record<string, HostBackgroundTaskStatus> = {
  completed: "completed",
  failed: "failed",
  killed: "stopped",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

/** Descriptions are labels: keep a long one shortened rather than lose it. */
function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, DESCRIPTION_LIMIT)
    : undefined;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(message.message) ? message.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function toolResultText(block: Record<string, unknown>): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

/** Bash tool_use commands and their tool_result bindings, shared by live and transcript reads. */
class BashCalls {
  readonly #commands = new Map<string, string>();
  readonly #tasks = new Map<string, { callId: string; outputFile?: string }>();

  observe(message: Record<string, unknown>): Array<{ taskId: string; callId: string }> {
    const bound: Array<{ taskId: string; callId: string }> = [];
    if (message.type === "assistant") {
      for (const block of contentBlocks(message)) {
        if (block.type !== "tool_use" || block.name !== "Bash" || !isRecord(block.input)) continue;
        const callId = text(block.id, ID_LIMIT);
        const command = text(block.input.command, COMMAND_LIMIT);
        if (callId && command) this.#commands.set(callId, command);
      }
    }
    if (message.type !== "user") return bound;
    // The SDK stream and the stored transcript name the structured result differently.
    const result = message.tool_use_result ?? message.toolUseResult;
    const taskId = isRecord(result) ? text(result.backgroundTaskId, ID_LIMIT) : undefined;
    for (const block of contentBlocks(message)) {
      if (block.type !== "tool_result") continue;
      const callId = text(block.tool_use_id, ID_LIMIT);
      if (!callId || !this.#commands.has(callId)) continue;
      if (!taskId) {
        this.#commands.delete(callId);
        continue;
      }
      const outputFile = OUTPUT_FILE_PATTERN.exec(toolResultText(block))?.[1];
      this.#tasks.set(taskId, { callId, ...(outputFile ? { outputFile } : {}) });
      bound.push({ taskId, callId });
    }
    return bound;
  }

  isBackgroundCall(callId: string): boolean {
    return this.#commands.has(callId);
  }

  command(callId: string | undefined): string | undefined {
    return callId ? this.#commands.get(callId) : undefined;
  }

  binding(taskId: string): { callId: string; outputFile?: string } | undefined {
    return this.#tasks.get(taskId);
  }
}

/**
 * Interprets one Claude CLI process's native background Bash tasks. The live
 * level replaces membership; leaving it without a native result is `unknown`,
 * never success. Settled tasks never return to running; a later native result
 * may still replace `unknown`. Agent tasks stay on the Subagent path.
 */
export class ClaudeBackgroundCommandTracker {
  readonly #calls = new BashCalls();
  readonly #commands = new Map<string, ClaudeBackgroundCommand>();
  readonly #taskCalls = new Map<string, string>();

  /** Returns commands whose observed facts changed. */
  consume(message: unknown): ClaudeBackgroundCommand[] {
    if (!isRecord(message)) return [];
    const changed = new Map<string, ClaudeBackgroundCommand>();
    const apply = (taskId: string, next: ClaudeBackgroundCommand | undefined) => {
      if (!next) return;
      const previous = this.#commands.get(taskId);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      this.#commands.set(taskId, next);
      changed.set(taskId, next);
    };
    for (const { taskId, callId } of this.#calls.observe(message)) {
      this.#taskCalls.set(taskId, callId);
      apply(taskId, this.#withFacts(this.#commands.get(taskId)));
    }
    if (message.type !== "system") return [...changed.values()];

    if (message.subtype === "background_tasks_changed" && Array.isArray(message.tasks)) {
      const live = new Set<string>();
      for (const entry of message.tasks) {
        if (!isRecord(entry) || entry.task_type !== BACKGROUND_TASK_TYPE) continue;
        const taskId = text(entry.task_id, ID_LIMIT);
        if (!taskId) continue;
        live.add(taskId);
        apply(taskId, this.#started(taskId, label(entry.description), "level"));
      }
      for (const [taskId, current] of this.#commands) {
        if (current.task.status === "running" && !live.has(taskId)) {
          apply(taskId, this.#withStatus(current, "unknown"));
        }
      }
      return [...changed.values()];
    }

    const taskId = text(message.task_id, ID_LIMIT);
    if (!taskId) return [...changed.values()];
    const callId = text(message.tool_use_id, ID_LIMIT);
    if (callId && this.#calls.isBackgroundCall(callId)) this.#taskCalls.set(taskId, callId);

    if (message.subtype === "task_started") {
      if (message.task_type !== BACKGROUND_TASK_TYPE) return [...changed.values()];
      apply(taskId, this.#started(taskId, label(message.description), "edge"));
    } else if (message.subtype === "task_updated" && isRecord(message.patch)) {
      const status = UPDATED_STATUS[String(message.patch.status)];
      const current = this.#unsettled(taskId);
      if (status && current) apply(taskId, this.#withStatus(current, status));
    } else if (message.subtype === "task_notification") {
      const status = NOTIFICATION_STATUS[String(message.status)];
      const current = this.#commands.get(taskId) ?? this.#unsettled(taskId);
      // The notification completes an update's result, but never replaces another result.
      if (status && current && (this.#unsettled(taskId) || current.task.status === status)) {
        const outputFile = text(message.output_file, PATH_LIMIT);
        const summary = current.summary ?? label(message.summary);
        apply(taskId, {
          ...this.#withStatus(current, status),
          ...(outputFile ? { outputFile } : {}),
          ...(summary ? { summary } : {}),
        });
      }
    }
    return [...changed.values()];
  }

  /**
   * The live level is authoritative: a task it lists again is running, even if
   * an earlier level had dropped it to `unknown`. A start edge may arrive after
   * that level and cannot revive it. Neither overrides a native result.
   */
  /** A task this process reported as a background command, never a Subagent. */
  has(taskId: string): boolean {
    return this.#commands.has(taskId);
  }

  #started(
    taskId: string,
    description: string | undefined,
    source: "level" | "edge",
  ): ClaudeBackgroundCommand | undefined {
    const current = this.#commands.get(taskId);
    if (current) {
      const live =
        current.task.status === "running" ||
        (source === "level" && current.task.status === "unknown");
      return this.#withFacts(
        live
          ? {
              ...current,
              task: {
                ...current.task,
                status: "running",
                ...(description ? { description } : {}),
              },
            }
          : current,
      );
    }
    return this.#withFacts({
      task: {
        kind: "command",
        nativeTaskId: taskId,
        description:
          description ?? label(this.#calls.command(this.#taskCalls.get(taskId))) ?? taskId,
        status: "running",
      },
    });
  }

  /**
   * A known Bash task without a native result yet. A result for a task first
   * seen here must come from an observed background Bash call.
   */
  #unsettled(taskId: string): ClaudeBackgroundCommand | undefined {
    const current = this.#commands.get(taskId);
    if (current) {
      return current.task.status === "running" || current.task.status === "unknown"
        ? current
        : undefined;
    }
    const command = this.#calls.command(this.#taskCalls.get(taskId));
    if (!command) return undefined;
    return this.#withFacts({
      task: {
        kind: "command",
        nativeTaskId: taskId,
        description: command.slice(0, DESCRIPTION_LIMIT),
        status: "unknown",
      },
    });
  }

  #withStatus(
    current: ClaudeBackgroundCommand,
    status: HostBackgroundTaskStatus,
  ): ClaudeBackgroundCommand {
    return { ...current, task: { ...current.task, status } };
  }

  #withFacts(current: ClaudeBackgroundCommand | undefined): ClaudeBackgroundCommand | undefined {
    if (!current) return undefined;
    const taskId = current.task.nativeTaskId;
    const command = current.command ?? this.#calls.command(this.#taskCalls.get(taskId));
    const outputFile = current.outputFile ?? this.#calls.binding(taskId)?.outputFile;
    return {
      ...current,
      ...(command ? { command } : {}),
      ...(outputFile ? { outputFile } : {}),
    };
  }
}

const NOTIFICATION_FIELD = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u");

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/**
 * Stored transcript facts for a task no live process observes. The transcript
 * keeps the Bash call, its result and a delivered task notification; without a
 * notification the ending is `unknown`, never running. Only the native
 * notification envelope (Claude CLI 2.1.273 `origin.kind: "task-notification"`)
 * naming the observed Bash call counts; ordinary user text never does.
 */
export function claudeBackgroundCommandFromTranscript(
  messages: readonly unknown[],
  taskId: string,
): ClaudeBackgroundCommand | null {
  const calls = new BashCalls();
  const notifications: Array<{
    callId: string;
    status: HostBackgroundTaskStatus;
    outputFile?: string;
    summary?: string;
  }> = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    calls.observe(message);
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (
      message.type !== "user" ||
      !isRecord(message.origin) ||
      message.origin.kind !== "task-notification" ||
      typeof content !== "string"
    ) {
      continue;
    }
    if (NOTIFICATION_FIELD("task-id").exec(content)?.[1] !== taskId) continue;
    const callId = NOTIFICATION_FIELD("tool-use-id").exec(content)?.[1];
    const status = NOTIFICATION_STATUS[NOTIFICATION_FIELD("status").exec(content)?.[1] ?? ""];
    if (!callId || !status) continue;
    const outputFile = NOTIFICATION_FIELD("output-file").exec(content)?.[1];
    const summary = NOTIFICATION_FIELD("summary").exec(content)?.[1];
    notifications.push({
      callId,
      status,
      ...(outputFile ? { outputFile: unescapeXml(outputFile) } : {}),
      ...(summary ? { summary: unescapeXml(summary) } : {}),
    });
  }
  const binding = calls.binding(taskId);
  const command = calls.command(binding?.callId);
  if (!binding || !command) return null;
  // The first native result for the observed call is final, as in the live tracker.
  const notification = notifications.find(({ callId }) => callId === binding.callId);
  const outputFile = notification?.outputFile ?? binding.outputFile;
  return {
    task: {
      kind: "command",
      nativeTaskId: taskId,
      description: command.slice(0, DESCRIPTION_LIMIT),
      status: notification?.status ?? "unknown",
    },
    command,
    ...(outputFile ? { outputFile } : {}),
    ...(notification?.summary ? { summary: notification.summary } : {}),
  };
}

export interface ClaudeBackgroundOutput {
  text: string;
  truncated: boolean;
}

/** Reads the latest native output tail; a missing or unreadable file is unavailable. */
export async function readClaudeBackgroundOutput(
  outputFile: string | undefined,
  limitBytes: number,
): Promise<ClaudeBackgroundOutput | null> {
  if (!outputFile) return null;
  let handle;
  try {
    handle = await open(outputFile, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limitBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: size > length };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const ITEM_OUTCOME = {
  running: { status: "running" },
  completed: { status: "succeeded" },
  failed: {
    status: "failed",
    error: { code: "nativeFailure", message: "Background command failed", retryable: false },
  },
  stopped: { status: "cancelled", reason: "Background command was stopped" },
  unknown: { status: "unknown", reason: "Background command ended without a native result" },
} as const;

/**
 * Read-only detail: one command Item. Output is the native output file when it
 * can still be read; otherwise the detail states that it is unavailable.
 */
export function claudeBackgroundCommandSnapshot(
  parent: NativeSessionRef,
  command: ClaudeBackgroundCommand,
  output: ClaudeBackgroundOutput | null,
): HostThreadSnapshot {
  const { task } = command;
  const notes = [
    task.description,
    ...(command.summary ? [command.summary] : []),
    ...(task.status === "unknown"
      ? ["Result unknown: the command ended without a native result."]
      : []),
    ...(output === null ? ["Native output is unavailable."] : []),
  ];
  const itemOutcome = ITEM_OUTCOME[task.status];
  return {
    turns: [
      {
        nativeTurnRef: {
          harnessId: parent.harnessId,
          nativeSessionId: parent.nativeSessionId,
          nativeTurnKey: `background-task:${task.nativeTaskId}`,
          formatVersion: 1,
        },
        input: [{ type: "text", text: notes.join("\n\n") }],
        items: [
          {
            item: {
              type: "commandExecution",
              itemId: hostItemIdSchema.parse(`background-task:${task.nativeTaskId}`),
              command: command.command ?? "",
              ...(output ? { output: output.text, outputTruncated: output.truncated } : {}),
            },
            outcome: itemOutcome,
          },
        ],
        outcome:
          itemOutcome.status === "running" ? { status: "unknown", reason: "Running" } : itemOutcome,
      },
    ],
  };
}
