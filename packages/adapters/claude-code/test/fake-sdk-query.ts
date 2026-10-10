import { vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Scripted Claude Agent SDK Query: tests push native messages in the order Claude emits them. */
export class FakeQuery {
  readonly accountInfo = vi.fn(async () => ({ apiProvider: "firstParty" as const }));
  readonly initializationResult = vi.fn(async () => ({
    models: [
      {
        value: "default",
        displayName: "Default",
        description: "Default",
        supportsAutoMode: true,
      },
    ],
  }));
  readonly interrupt = vi.fn(async () => undefined);
  readonly stopTask = vi.fn(async (taskId: string) => {
    this.push({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      status: "stopped",
    } as unknown as SDKMessage);
  });
  readonly getContextUsage = vi.fn(
    async (): Promise<{
      totalTokens: number;
      maxTokens: number;
      model: string;
    }> => ({
      totalTokens: 40,
      maxTokens: 200,
      model: "runtime-model",
    }),
  );
  readonly setModel = vi.fn(async () => undefined);
  readonly applyFlagSettings = vi.fn(async () => undefined);
  readonly getSettings = vi.fn(async (): Promise<unknown> => ({
    applied: {
      effort: "xhigh",
      ultracode: true,
      ultracodeRequested: true,
      ultracodeAvailable: true,
    },
  }));
  readonly setPermissionMode = vi.fn(async () => undefined);
  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: message });
    else this.#messages.push(message);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
