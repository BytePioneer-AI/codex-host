import type { Query, SDKMessage, SDKUserMessage } from "@qwen-code/sdk";
import { describe, expect, it, vi } from "vitest";

import { QwenCodeSdkTransport } from "../src/sdk-transport.js";

class FakeQuery implements AsyncIterable<SDKMessage> {
  readonly initialized = Promise.resolve();
  readonly close = vi.fn(async () => undefined);
  readonly getAvailableModels = vi.fn(async () => ({
    subtype: "get_available_models",
    models: [{ id: "qwen-max", label: "Qwen Max", contextWindowSize: 1_000_000 }],
  }));
  readonly getSessionId = vi.fn(() => "550e8400-e29b-41d4-a716-446655440000");
  readonly interrupt = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  readonly setPermissionMode = vi.fn(async () => undefined);
  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];

  emit(message: SDKMessage): void {
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

describe("QwenCodeSdkTransport", () => {
  it("opens the official SDK query with session-scoped configuration", async () => {
    const query = new FakeQuery();
    let input: AsyncIterable<SDKUserMessage> | undefined;
    let options: Record<string, unknown> | undefined;
    const queryFactory = vi.fn(({ prompt, options: received }) => {
      input = prompt;
      options = received;
      return query as unknown as Query;
    });
    const transport = new QwenCodeSdkTransport({
      cwd: process.cwd(),
      command: process.execPath,
      environment: { CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1" },
      queryFactory: queryFactory as unknown as typeof import("@qwen-code/sdk").query,
    });

    const opened = await transport.open({ kind: "create", permissionMode: "yolo" as never });

    expect(opened).toMatchObject({
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      resumed: false,
      models: {
        currentModelId: "qwen-max",
        availableModels: [
          { modelId: "qwen-max", name: "Qwen Max", _meta: { contextLimit: 1_000_000 } },
        ],
      },
    });
    expect(queryFactory).toHaveBeenCalledOnce();
    expect(options).toMatchObject({
      cwd: process.cwd(),
      env: { CODEXHOST_DELEGATION_THREAD_ID: "child-thread-1" },
      includePartialMessages: true,
      permissionMode: "yolo",
    });
    expect(options).toHaveProperty("sessionId");
    expect(options).not.toHaveProperty("resume");

    const turn = transport.runTurn("status", vi.fn(), vi.fn(async () => ({ behavior: "allow" })));
    const sent = await input?.[Symbol.asyncIterator]().next();
    expect(sent?.value).toMatchObject({
      type: "user",
      session_id: opened.sessionId,
      message: { role: "user", content: "status" },
    });
    query.emit({
      type: "result",
      subtype: "success",
      uuid: "result-1",
      session_id: opened.sessionId,
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "ok",
      usage: {},
      permission_denials: [],
    });
    await expect(turn).resolves.toEqual({ status: "succeeded" });
    await transport.close();
  });

  it("resumes an SDK session and projects streamed agent, tool, and usage events", async () => {
    const query = new FakeQuery();
    let options: Record<string, unknown> | undefined;
    const transport = new QwenCodeSdkTransport({
      cwd: process.cwd(),
      command: process.execPath,
      queryFactory: (({ options: received }) => {
        options = received;
        return query as unknown as Query;
      }) as unknown as typeof import("@qwen-code/sdk").query,
    });
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    await transport.open({ kind: "resume", sessionId, permissionMode: "plan" as never });
    expect(options).toMatchObject({ resume: sessionId, permissionMode: "plan" });
    expect(options).not.toHaveProperty("sessionId");

    const events: unknown[] = [];
    const turn = transport.runTurn("status", (event) => events.push(event), async () => ({
      behavior: "allow",
    }));
    query.emit({
      type: "stream_event",
      uuid: "stream-1",
      session_id: sessionId,
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
    });
    query.emit({
      type: "assistant",
      uuid: "assistant-1",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: "assistant-message-1",
        type: "message",
        role: "assistant",
        model: "qwen-max",
        content: [{ type: "tool_use", id: "tool-1", name: "run_shell_command", input: { command: "git status" } }],
        usage: {},
      },
    } as SDKMessage);
    query.emit({
      type: "user",
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "clean", is_error: false }],
      },
    } as SDKMessage);
    query.emit({
      type: "result",
      subtype: "success",
      uuid: "result-1",
      session_id: sessionId,
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: "ok",
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      permission_denials: [],
    });

    await expect(turn).resolves.toEqual({ status: "succeeded" });
    expect(events).toEqual([
      { type: "agent.text", text: "done" },
      {
        type: "tool.call",
        callId: "tool-1",
        title: "run_shell_command",
        name: "run_shell_command",
        kind: "execute",
        rawInput: { command: "git status" },
      },
      { type: "tool.update", callId: "tool-1", status: "completed", rawOutput: "clean" },
      { type: "usage", metadata: { usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
    ]);
    await transport.close();
  });
});
