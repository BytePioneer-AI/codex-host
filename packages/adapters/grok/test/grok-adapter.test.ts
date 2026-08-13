import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { harnessModelRefSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  GrokAdapter,
  type GrokAcpTransportLike,
  type GrokOpenResult,
  type GrokPermissionRequest,
  type GrokTransportEvent,
} from "../src/index.js";

const initialize: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  _meta: {
    modelState: {
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            reasoningEffort: "high",
            reasoningEfforts: [
              { id: "high", label: "High" },
              { id: "low", label: "Low" },
            ],
          },
        },
      ],
    },
  },
};

class FakeGrokTransport implements GrokAcpTransportLike {
  sessionId = "grok-session";
  readonly cancel = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly setModel = vi.fn(async () => undefined);
  replay: GrokTransportEvent[] = [];
  #onEvent: ((event: GrokTransportEvent) => void) | null = null;
  #onPermission: ((request: GrokPermissionRequest) => Promise<RequestPermissionResponse>) | null =
    null;
  #resolve: ((response: PromptResponse) => void) | null = null;

  async inspect(): Promise<InitializeResponse> {
    return initialize;
  }

  async open(
    input: { kind: "create" } | { kind: "resume"; sessionId: string },
  ): Promise<GrokOpenResult> {
    if (input.kind === "resume") this.sessionId = input.sessionId;
    return {
      initialize,
      session: { sessionId: this.sessionId },
      sessionId: this.sessionId,
      replay: [...this.replay],
    };
  }

  runTurn(
    _text: string,
    onEvent: (event: GrokTransportEvent) => void,
    onPermission: (request: GrokPermissionRequest) => Promise<RequestPermissionResponse>,
  ): Promise<PromptResponse> {
    this.#onEvent = onEvent;
    this.#onPermission = onPermission;
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  event(event: GrokTransportEvent): void {
    this.#onEvent?.(event);
  }

  permission(): Promise<RequestPermissionResponse> {
    if (!this.#onPermission) throw new Error("No active Grok Prompt");
    return this.#onPermission({
      request: {
        sessionId: this.sessionId,
        toolCall: { toolCallId: "tool-1", title: "Run tests" },
        options: [
          { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
          { optionId: "native-deny", name: "Reject", kind: "reject_once" },
        ],
      },
      options: [
        { optionId: "native-allow", name: "Allow once", kind: "allow_once" },
        { optionId: "native-deny", name: "Reject", kind: "reject_once" },
      ],
    });
  }

  finish(response: PromptResponse = { stopReason: "end_turn" }): void {
    this.#resolve?.(response);
    this.#resolve = null;
  }
}

async function openedSession(transport: FakeGrokTransport, kind: "create" | "resume" = "create") {
  let uuid = 0;
  const adapter = new GrokAdapter(
    {},
    {
      randomUUID: () => `grok-id-${++uuid}`,
      createTransport: () => transport,
    },
  );
  const opened = await adapter.open(
    kind === "create"
      ? { kind: "create", cwd: "/synthetic" }
      : {
          kind: "resume",
          cwd: "/synthetic",
          nativeRef: {
            harnessId: adapter.harnessId,
            nativeSessionId: transport.sessionId,
            formatVersion: 1,
          },
        },
  );
  if (!opened.ok) throw new Error(opened.error.message);
  return { adapter, session: opened.value };
}

async function nextOutput(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput> {
  const result = await iterator.next();
  if (result.done) throw new Error("Grok output ended unexpectedly");
  return result.value;
}

async function nextEvent(
  iterator: AsyncIterator<HarnessOutput>,
): Promise<Extract<HarnessOutput, { kind: "event" }>["event"]> {
  const output = await nextOutput(iterator);
  if (output.kind !== "event") throw new Error("Expected Grok Event");
  return output.event;
}

describe("Grok Adapter ACP projection", () => {
  it("projects Thinking, Tool, Approval, Text, Usage, and terminal in order", async () => {
    const transport = new FakeGrokTransport();
    const { adapter, session } = await openedSession(transport);
    const iterator = session.outputs[Symbol.asyncIterator]();
    const turnId = hostTurnIdSchema.parse("turn-1");

    await expect(
      session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "test" }] }),
    ).resolves.toEqual({ ok: true, value: { turnId } });
    expect((await nextEvent(iterator)).type).toBe("turn.started");

    transport.event({ type: "agent.thought", text: "checking", messageId: "message-1" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");

    transport.event({
      type: "tool.call",
      callId: "tool-1",
      title: "Run tests",
      name: "bash",
      rawInput: { command: "npm test" },
      status: "in_progress",
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect((await nextEvent(iterator)).type).toBe("item.started");

    const permission = transport.permission();
    const interactionOutput = await nextOutput(iterator);
    if (interactionOutput.kind !== "interaction") throw new Error("Expected Grok Approval");
    expect(interactionOutput.interaction).toMatchObject({
      type: "approval",
      title: "Run tests",
      actions: [
        { id: "native-1", effect: "allowOnce" },
        { id: "native-2", effect: "deny" },
      ],
    });
    await expect(
      session.execute({
        type: "interaction.respond",
        interactionId: interactionOutput.interaction.interactionId,
        response: { type: "approval", actionId: "native-1" },
      }),
    ).resolves.toEqual({ ok: true, value: { accepted: true } });
    await expect(permission).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "native-allow" },
    });
    expect((await nextEvent(iterator)).type).toBe("interaction.closed");

    transport.event({
      type: "tool.update",
      callId: "tool-1",
      status: "completed",
      rawOutput: "passed",
    });
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    transport.event({ type: "agent.text", text: "done", messageId: "message-2" });
    expect((await nextEvent(iterator)).type).toBe("item.started");
    expect((await nextEvent(iterator)).type).toBe("item.updated");
    transport.finish({
      stopReason: "end_turn",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect((await nextEvent(iterator)).type).toBe("item.completed");
    expect(await nextEvent(iterator)).toMatchObject({
      type: "session.usage.changed",
      usage: { totalTokens: 8, inputTokens: 5, outputTokens: 3 },
    });
    expect(await nextEvent(iterator)).toMatchObject({
      type: "turn.completed",
      outcome: { status: "succeeded" },
    });
    await adapter.close();
  });

  it("cancels the active ACP Prompt and maps replay into a resumable Snapshot", async () => {
    const transport = new FakeGrokTransport();
    transport.replay = [
      { type: "user.text", text: "before", messageId: "user-1" },
      { type: "agent.thought", text: "thought", messageId: "agent-1" },
      { type: "agent.text", text: "answer", messageId: "agent-1" },
    ];
    const { adapter, session } = await openedSession(transport, "resume");
    const snapshot = await session.readSnapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: {
        turns: [
          {
            input: [{ type: "text", text: "before" }],
            items: [
              { item: { type: "reasoning", text: "thought" } },
              { item: { type: "agentMessage", text: "answer" } },
            ],
          },
        ],
      },
    });

    const turnId = hostTurnIdSchema.parse("turn-cancel");
    await session.execute({ type: "turn.start", turnId, input: [{ type: "text", text: "stop" }] });
    await expect(session.execute({ type: "turn.cancel", turnId })).resolves.toEqual({
      ok: true,
      value: { cancellationRequested: true },
    });
    expect(transport.cancel).toHaveBeenCalledOnce();
    transport.finish({ stopReason: "cancelled" });
    await adapter.close();
  });

  it("rejects unsupported history mutation and invalid create Model selection", async () => {
    const transport = new FakeGrokTransport();
    const adapter = new GrokAdapter(
      {},
      { randomUUID: vi.fn(() => "id"), createTransport: () => transport },
    );
    await expect(
      adapter.open({
        kind: "create",
        cwd: "/synthetic",
        model: harnessModelRefSchema.parse({ id: "missing" }),
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "protocolError" } });
    await expect(
      adapter.open({
        kind: "rollbackLastTurn",
        cwd: "/synthetic",
        sourceRef: { harnessId: adapter.harnessId, nativeSessionId: "session", formatVersion: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });
});
