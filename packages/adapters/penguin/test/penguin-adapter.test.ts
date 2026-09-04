import { describe, expect, it } from "vitest";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import {
  PenguinAdapter,
  type PenguinApiClient,
  type PenguinConnection,
  type PenguinRequestOptions,
  type PenguinSseFrame,
} from "../src/index.js";
import { encodePenguinModelRef } from "../src/model-catalog.js";

const model = encodePenguinModelRef({ provider: "openai", modelId: "gpt-test" });
const alternateModel = encodePenguinModelRef({ provider: "openai", modelId: "gpt-alternate" });

class FakePenguinConnection implements PenguinConnection {
  readonly endpoint = "http://127.0.0.1:7364";
  readonly calls: Array<{ path: string; options: PenguinRequestOptions }> = [];
  readonly taskBodies: unknown[] = [];
  readonly client: PenguinApiClient = {
    request: <T>(path: string, options?: PenguinRequestOptions) => this.request<T>(path, options),
    stream: (sessionId: string, signal?: AbortSignal, lastEventId?: string) =>
      this.stream(sessionId, signal, lastEventId),
  };
  closed = false;
  #session = {
    sessionId: "session-1",
    projectId: "project-1",
    agentId: "agent-1",
    provider: "openai",
    modelId: "gpt-test",
    workspace: "/workspace",
    approvalMode: "always-ask",
    thinkingLevel: "medium",
    status: "idle",
  };

  emitIdleEvent = true;
  emitRequestEnd = true;
  async request<T>(path: string, options: PenguinRequestOptions = {}): Promise<T> {
    this.calls.push({ path, options });
    if (path === "/api/projects") return { projects: [{ id: "project-1" }] } as T;
    if (path === "/api/projects/project-1/agents") return { agents: [{ id: "agent-1" }] } as T;
    if (path === "/api/projects/project-1/models") {
      return {
        models: [
          { provider: "openai", modelId: "gpt-test", displayName: "GPT Test" },
          { provider: "openai", modelId: "gpt-alternate", displayName: "GPT Alternate" },
        ],
        defaultModel: { provider: "openai", modelId: "gpt-test" },
      } as T;
    }
    if (path === "/api/projects/project-1/agents/agent-1/sessions") {
      const body = options.body;
      const create =
        typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      return {
        session: {
          ...this.#session,
          ...(typeof create.provider === "string" ? { provider: create.provider } : {}),
          ...(typeof create.modelId === "string" ? { modelId: create.modelId } : {}),
        },
      } as T;
    }
    if (path === "/api/sessions/session-1" && options.method === "PATCH") {
      const body = options.body;
      if (typeof body === "object" && body !== null) {
        const patch = body as Record<string, unknown>;
        if (typeof patch.thinkingLevel === "string")
          this.#session.thinkingLevel = patch.thinkingLevel;
        if (typeof patch.approvalMode === "string") this.#session.approvalMode = patch.approvalMode;
        if (typeof patch.provider === "string") this.#session.provider = patch.provider;
        if (typeof patch.modelId === "string") this.#session.modelId = patch.modelId;
      }
      return { session: { ...this.#session } } as T;
    }
    if (path === "/api/sessions/session-1") return { session: { ...this.#session } } as T;
    if (path === "/api/sessions/session-1/messages") return { messages: [] } as T;
    if (path === "/api/sessions/session-1/tasks") {
      this.taskBodies.push(options.body);
      this.#session.status = "running";
      return { sessionId: "session-1", queued: false } as T;
    }
    if (path === "/api/sessions/session-1/abort") return undefined as T;
    throw new Error(`Unexpected fake Penguin API path: ${path}`);
  }

  async *stream(
    sessionId: string,
    signal?: AbortSignal,
    lastEventId?: string,
  ): AsyncIterable<PenguinSseFrame> {
    void sessionId;
    void signal;
    void lastEventId;
    yield {
      event: "server_event",
      data: JSON.stringify({ type: "task_state", state: "running" }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: {
          type: "partial_thinking",
          role: "assistant",
          event_type: "delta",
          thinking: "Plan",
        },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: {
          type: "partial_thinking",
          role: "assistant",
          event_type: "stop",
          thinking: "",
        },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: { type: "thinking", role: "assistant", thinking: "Plan" },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: {
          type: "partial_text",
          role: "assistant",
          event_type: "delta",
          text: "Penguin finished",
        },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: {
          type: "partial_text",
          role: "assistant",
          event_type: "stop",
          text: "",
        },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "model_msg",
        payload: { type: "text", role: "assistant", text: "Penguin finished" },
      }),
    };
    yield {
      data: JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_usage",
          session: { cache_read: 3, cache_write: 1, output: 5, total: 9 },
          request: { cache_read: 3, cache_write: 1, output: 5, total: 9 },
        },
      }),
    };
    if (this.emitRequestEnd) {
      yield {
        data: JSON.stringify({
          type: "event_msg",
          payload: { type: "request_end", status: "completed" },
        }),
      };
    }
    this.#session.status = "idle";
    if (!this.emitIdleEvent) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return;
    }
    yield {
      event: "server_event",
      data: JSON.stringify({ type: "task_state", state: "idle" }),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function collectUntilCompleted(
  outputs: AsyncIterable<HarnessOutput>,
): Promise<HarnessOutput[]> {
  const collected: HarnessOutput[] = [];
  for await (const output of outputs) {
    collected.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") {
      break;
    }
  }
  return collected;
}

describe("PenguinAdapter", () => {
  it("discovers Penguin, creates a native session, and streams a completed Turn", async () => {
    const connection = new FakePenguinConnection();
    const adapter = new PenguinAdapter(
      { projectId: "project-1", agentId: "agent-1", autoStartServer: false },
      {
        createConnection: async () => connection,
        randomUUID: () => "synthetic-id",
      },
    );

    await expect(adapter.inspect()).resolves.toMatchObject({ status: "ready" });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      model,
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
      permissionModeId: harnessPermissionModeIdSchema.parse("always-ask"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    expect(opened.value.harnessId).toBe("penguin");
    expect(opened.value.capabilities.configuration.selectModel).toBe(true);
    expect(opened.value.capabilities.configuration.modelSelectionScope).toBe("atCreate");
    expect(opened.value.initialState.effectiveModel).toEqual(model);
    expect(opened.value.initialState.effectiveThinkingOptionId).toBe("high");
    expect(connection.calls).toContainEqual(
      expect.objectContaining({
        path: "/api/projects/project-1/agents/agent-1/sessions",
        options: expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            workspace: "/workspace",
            provider: "openai",
            modelId: "gpt-test",
            approvalMode: "always-ask",
            client: "web",
          }),
        }),
      }),
    );

    const unsupportedModelSwitch = await opened.value.execute({
      type: "model.select",
      model: alternateModel,
    });
    expect(unsupportedModelSwitch).toMatchObject({ ok: false, error: { code: "unsupported" } });

    const alternateOpened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      model: alternateModel,
      permissionModeId: harnessPermissionModeIdSchema.parse("always-ask"),
    });
    if (!alternateOpened.ok) throw new Error(alternateOpened.error.message);
    expect(alternateOpened.value.initialState.effectiveModel).toEqual(alternateModel);
    expect(connection.calls).toContainEqual(
      expect.objectContaining({
        path: "/api/projects/project-1/agents/agent-1/sessions",
        options: expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({
            provider: "openai",
            modelId: "gpt-alternate",
          }),
        }),
      }),
    );
    await alternateOpened.value.close();

    const started = await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "Inspect this workspace" }],
    });
    expect(started).toEqual({ ok: true, value: { turnId: "turn-1" } });

    const outputs = await collectUntilCompleted(opened.value.outputs);
    expect(
      outputs.some((output) => output.kind === "event" && output.event.type === "item.started"),
    ).toBe(true);
    expect(
      outputs.flatMap((output) =>
        output.kind === "event" &&
        output.event.type === "item.started" &&
        (output.event.item.type === "agentMessage" || output.event.item.type === "reasoning")
          ? [{ type: output.event.item.type, text: output.event.item.text }]
          : [],
      ),
    ).toEqual([
      { type: "reasoning", text: "" },
      { type: "agentMessage", text: "" },
    ]);
    expect(outputs).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({ type: "agentMessage", text: "Penguin finished" }),
          }),
        }),
      }),
    );
    expect(outputs).toContainEqual({
      kind: "event",
      event: {
        type: "session.usage.changed",
        usage: {
          cachedInputTokens: 3,
          cacheWriteInputTokens: 1,
          outputTokens: 5,
          totalTokens: 9,
        },
        observedForTurnId: "turn-1",
      },
    });
    expect(outputs).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "item.completed",
          snapshot: expect.objectContaining({
            item: expect.objectContaining({ type: "reasoning", text: "Plan" }),
          }),
        }),
      }),
    );
    expect(outputs).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: { status: "succeeded" },
        }),
      }),
    );
    expect(connection.taskBodies[0]).toEqual({
      input: [{ type: "text", text: "Inspect this workspace" }],
      thinkingLevel: "high",
    });

    await opened.value.close();
    await adapter.close();
    expect(connection.closed).toBe(true);
  });

  it("completes a Turn when Penguin finishes but both terminal stream events are missed", async () => {
    const connection = new FakePenguinConnection();
    connection.emitRequestEnd = false;
    connection.emitIdleEvent = false;
    const adapter = new PenguinAdapter(
      { projectId: "project-1", agentId: "agent-1", autoStartServer: false },
      { createConnection: async () => connection, randomUUID: () => "synthetic-id" },
    );
    const opened = await adapter.open({
      kind: "create",
      cwd: "/workspace",
      model,
      permissionModeId: harnessPermissionModeIdSchema.parse("always-ask"),
    });
    if (!opened.ok) throw new Error(opened.error.message);

    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-with-missed-idle"),
      input: [{ type: "text", text: "Finish without terminal events" }],
    });

    const outputs = await collectUntilCompleted(opened.value.outputs);
    expect(outputs).toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "turn.completed",
          outcome: { status: "succeeded" },
        }),
      }),
    );
    expect(connection.calls).toContainEqual(
      expect.objectContaining({ path: "/api/sessions/session-1" }),
    );

    await opened.value.close();
    await adapter.close();
  });
});
