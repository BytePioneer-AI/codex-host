import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

import type { HostEvent, HostItemOutcome } from "@codexhost/harness-adapter";

import type { ClaudeTurnEvent } from "./transport.js";
import type { ClaudeDetachedCommand } from "./tool-lifecycle.js";

type TaskNotification = Extract<ClaudeTurnEvent, { type: "subagent.settled" }>;

const POLL_INTERVAL_MS = 1_000;
const READ_CHUNK_BYTES = 64 * 1024;
const UNAVAILABLE_OUTPUT = "Native output is unavailable.";

function notificationOutcome(status: TaskNotification["status"]): HostItemOutcome {
  if (status === "completed") return { status: "succeeded" };
  if (status === "failed") {
    return {
      status: "failed",
      error: {
        code: "nativeFailure",
        message: "Claude Code background command failed",
        retryable: false,
      },
    };
  }
  return { status: "cancelled", reason: "Background command stopped" };
}

interface FollowedCommand {
  command: ClaudeDetachedCommand;
  /** The live path from the result text, else the notification's structured path. */
  outputFile: string | undefined;
  offset: number;
  decoder: StringDecoder;
  output: string;
  /** The output file was opened at least once, so an empty output is real. */
  opened: boolean;
  truncated: boolean;
  timer: NodeJS.Timeout | null;
  reading: Promise<void>;
  /** Completed on the wire; a read still in flight must not append after it. */
  completed: boolean;
}

export interface ClaudeBackgroundCommandItemsOptions {
  outputLimit: number;
  emit(event: HostEvent): void;
}

/**
 * Follows detached Bash Items until their native `task_notification`: streams
 * the output file as `output.append` when its path is known, then completes the
 * Item on its Turn with the notification's result and full output.
 */
export class ClaudeBackgroundCommandItems {
  /** Keyed by the Bash `tool_use` id. */
  readonly #commands = new Map<string, FollowedCommand>();
  readonly #emit: (event: HostEvent) => void;
  readonly #outputLimit: number;

  constructor(options: ClaudeBackgroundCommandItemsOptions) {
    this.#emit = options.emit;
    this.#outputLimit = options.outputLimit;
  }

  taskIds(): string[] {
    return [...this.#commands.values()].map(({ command }) => command.taskId);
  }

  follow(command: ClaudeDetachedCommand): void {
    const followed: FollowedCommand = {
      command,
      outputFile: command.outputFile,
      offset: 0,
      decoder: new StringDecoder("utf8"),
      output: "",
      opened: false,
      truncated: false,
      timer: null,
      reading: Promise.resolve(),
      completed: false,
    };
    this.#commands.set(command.callId, followed);
    if (followed.outputFile) {
      followed.timer = setInterval(() => void this.#poll(followed), POLL_INTERVAL_MS);
      followed.timer.unref();
    }
  }

  /** Returns whether the notification settles a followed command. */
  settle(notification: TaskNotification): boolean {
    const followed = notification.callId ? this.#commands.get(notification.callId) : undefined;
    if (!followed) return false;
    this.#commands.delete(followed.command.callId);
    if (followed.timer) clearInterval(followed.timer);
    followed.outputFile ??= notification.outputFile;
    void this.#poll(followed).then(() =>
      this.#complete(followed, notificationOutcome(notification.status)),
    );
    return true;
  }

  /** The native process is gone; no notification can arrive any more. */
  abandonAll(reason: string): void {
    for (const followed of this.#commands.values()) {
      if (followed.timer) clearInterval(followed.timer);
      this.#complete(followed, { status: "cancelled", reason });
    }
    this.#commands.clear();
  }

  #poll(followed: FollowedCommand): Promise<void> {
    followed.reading = followed.reading.then(() => this.#read(followed));
    return followed.reading;
  }

  async #read(followed: FollowedCommand): Promise<void> {
    if (!followed.outputFile || followed.truncated) return;
    let handle;
    try {
      handle = await open(followed.outputFile, "r");
    } catch {
      return;
    }
    followed.opened = true;
    try {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, followed.offset);
        if (bytesRead === 0) return;
        followed.offset += bytesRead;
        this.#append(followed, followed.decoder.write(buffer.subarray(0, bytesRead)));
        if (followed.truncated) return;
      }
    } catch {
      return;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  #append(followed: FollowedCommand, text: string): void {
    if (text.length === 0 || followed.completed) return;
    const room = this.#outputLimit - followed.output.length;
    const accepted = text.length > room ? text.slice(0, Math.max(0, room)) : text;
    if (text.length > room) followed.truncated = true;
    if (accepted.length === 0) return;
    followed.output += accepted;
    this.#emit({
      type: "item.updated",
      turnId: followed.command.turnId,
      itemId: followed.command.item.itemId,
      update: { type: "output.append", text: accepted },
    });
  }

  #complete(followed: FollowedCommand, outcome: HostItemOutcome): void {
    const { command } = followed;
    followed.completed = true;
    const output =
      followed.output.length > 0
        ? followed.output
        : followed.opened
          ? undefined
          : UNAVAILABLE_OUTPUT;
    this.#emit({
      type: "item.completed",
      turnId: command.turnId,
      snapshot: {
        item: {
          ...command.item,
          ...(output !== undefined ? { output, outputTruncated: followed.truncated } : {}),
          durationMs: Math.max(0, Date.now() - command.startedAtMs),
        },
        outcome,
      },
    });
  }
}
