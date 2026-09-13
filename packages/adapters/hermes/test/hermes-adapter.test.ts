import { describe, expect, it } from "vitest";

import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";

import type { HermesOpenResult, HermesTransportEvent } from "../src/acp-transport.js";
import { HermesAcpTransport, HermesTransportError } from "../src/acp-transport.js";
import { encodeHermesModelRef } from "../src/hermes-models.js";
import { HermesSession } from "../src/hermes-session.js";

class FakeTurnTransport {
  onFault = () => undefined;

  async runTurn(
    _text: string,
    onEvent: (event: HermesTransportEvent) => void,
  ): Promise<{ stopReason: "end_turn" }> {
    onEvent({ type: "agent.thought", text: "think " });
    onEvent({ type: "agent.thought", text: "carefully" });
    onEvent({ type: "agent.text", text: "hello " });
    onEvent({ type: "agent.text", text: "world" });
    return { stopReason: "end_turn" };
  }

  async close(): Promise<void> {}
  async cancel(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
}

function openResult(): HermesOpenResult {
  return {
    initialize: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    },
    session: {
      sessionId: "native-session-1",
      models: null,
      modes: null,
    },
    sessionId: "native-session-1",
    replay: [],
  };
}

async function collectUntilTurnCompleted(
  outputs: AsyncIterable<HarnessOutput>,
): Promise<HarnessOutput[]> {
  const collected: HarnessOutput[] = [];
  for await (const output of outputs) {
    collected.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") return collected;
  }
  throw new Error("Hermes output ended before turn.completed");
}

describe("HermesSession text projection", () => {
  it("completes streamed text with exactly the text sent through append updates", async () => {
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: harnessIdSchema.parse("hermes"),
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    const started = await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-1"),
      input: [{ type: "text", text: "go" }],
    });
    expect(started.ok).toBe(true);

    const outputs = await outputsPromise;
    const events = outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
    const starts = events.filter((event) => event.type === "item.started");
    const completions = events.filter((event) => event.type === "item.completed");

    expect(
      starts.map((event) => (event.type === "item.started" ? event.item : null)),
    ).toMatchObject([
      { type: "reasoning", text: "" },
      { type: "agentMessage", text: "" },
    ]);
    expect(
      completions.map((event) => (event.type === "item.completed" ? event.snapshot.item : null)),
    ).toMatchObject([
      { type: "reasoning", text: "think carefully" },
      { type: "agentMessage", text: "hello world" },
    ]);

    await session.close();
  });

  it("keeps streamed text items ordered around a tool call", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (
        _text: string,
        onEvent: (event: HermesTransportEvent) => void,
      ): Promise<{ stopReason: "end_turn" }> => {
        onEvent({ type: "agent.text", text: "before" });
        onEvent({
          type: "tool.call",
          toolCallId: "tool-between-text",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-between-text",
            title: "Run command",
            status: "completed",
          },
        } as HermesTransportEvent);
        onEvent({ type: "agent.text", text: "after" });
        return { stopReason: "end_turn" };
      },
      close: async () => undefined,
      cancel: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-text-tool-text"),
      input: [{ type: "text", text: "go" }],
    });
    const outputs = await outputsPromise;
    const completedTypes = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "item.completed"
        ? [output.event.snapshot.item.type]
        : [],
    );
    expect(completedTypes).toEqual(["agentMessage", "toolExecution", "agentMessage"]);

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.items.map(({ item }) => item.type)).toEqual([
        "agentMessage",
        "toolExecution",
        "agentMessage",
      ]);
      expect(snapshot.value.turns[0]?.items[0]?.item).toMatchObject({ text: "before" });
      expect(snapshot.value.turns[0]?.items[2]?.item).toMatchObject({ text: "after" });
    }
    await session.close();
  });

  it("merges terminal token totals with the latest context usage", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({ type: "usage", used: 120, size: 1_000 });
        return {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
        };
      },
      close: async () => undefined,
      cancel: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-merged-usage"),
      input: [{ type: "text", text: "go" }],
    });
    const outputs = await outputsPromise;
    const usages = outputs.flatMap((output) =>
      output.kind === "event" && output.event.type === "session.usage.changed"
        ? [output.event.usage]
        : [],
    );
    expect(usages.at(-1)).toEqual({
      contextUsedTokens: 120,
      contextWindowTokens: 1_000,
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
    });
    await session.close();
  });
});

describe("HermesSession recovery", () => {
  it("accumulates replayed user chunks into one restored prompt", async () => {
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: {
        ...openResult(),
        replay: [
          { type: "user.text", text: "first " },
          { type: "user.text", text: "second" },
          { type: "agent.text", text: "answer" },
        ],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns).toHaveLength(1);
      expect(snapshot.value.turns[0]?.input).toEqual([{ type: "text", text: "first second" }]);
    }
    await session.close();
  });

  it("restores replayed Turns with an unknown outcome", async () => {
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: {
        ...openResult(),
        replay: [
          { type: "user.text", text: "hello" },
          { type: "agent.text", text: "partial answer" },
        ],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.outcome).toMatchObject({ status: "unknown" });
    }
    await session.close();
  });

  it("reuses known native Turn refs when replaying the same history", async () => {
    const knownTurnRef = nativeTurnRefSchema.parse({
      harnessId: "hermes",
      nativeSessionId: "native-session-1",
      nativeTurnKey: "stable-native-turn-1",
      formatVersion: 1,
    });
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: {
        ...openResult(),
        replay: [
          { type: "user.text", text: "hello" },
          { type: "agent.text", text: "world" },
        ],
      },
      knownTurnRefs: [knownTurnRef],
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(knownTurnRef);
    await session.close();
  });

  it("restores terminal tool output and failure from replay updates", async () => {
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: new FakeTurnTransport() as unknown as HermesAcpTransport,
      open: {
        ...openResult(),
        replay: [
          { type: "user.text", text: "run it" },
          {
            type: "tool.call",
            toolCallId: "tool-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Run command",
              status: "pending",
              rawInput: { command: "false" },
            },
          },
          {
            type: "tool.update",
            toolCallId: "tool-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "failed",
              rawOutput: "exit code 1",
            },
          },
        ] as HermesTransportEvent[],
      },
      onSettle: () => undefined,
    });

    const snapshot = await session.readSnapshot();

    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns[0]?.items[0]).toMatchObject({
        item: {
          type: "toolExecution",
          toolName: "Run command",
          output: { content: [{ type: "text", text: "exit code 1" }] },
        },
        outcome: { status: "failed" },
      });
    }
    await session.close();
  });
});

describe("HermesSession terminal events", () => {
  it("preserves partial tool output when the Turn ends without a terminal update", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "partial-tool-call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "partial-tool-call",
            title: "Long command",
            status: "in_progress",
          },
        } as HermesTransportEvent);
        onEvent({
          type: "tool.update",
          toolCallId: "partial-tool-call",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "partial-tool-call",
            status: "in_progress",
            rawOutput: "partial output",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-partial-tool-output"),
      input: [{ type: "text", text: "run" }],
    });
    const outputs = await outputsPromise;
    const completed = outputs.find(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );

    expect(completed).toMatchObject({
      kind: "event",
      event: {
        type: "item.completed",
        snapshot: {
          item: { output: { content: [{ type: "text", text: "partial output" }] } },
          outcome: { status: "cancelled" },
        },
      },
    });
    await session.close();
  });

  it("sends leading and trailing prompt whitespace to Hermes unchanged", async () => {
    let receivedText = "";
    const transport = {
      onFault: () => undefined,
      runTurn: async (text: string) => {
        receivedText = text;
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });
    const input = "  indented prompt\n\n";

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-preserve-whitespace"),
      input: [{ type: "text", text: input }],
    });
    await outputsPromise;

    expect(receivedText).toBe(input);
    await session.close();
  });

  it("immediately terminalizes a failed tool_call carrying its initial output", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "terminal-tool-call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "terminal-tool-call",
            title: "Run command",
            status: "failed",
            rawOutput: "exit code 1",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-initial-terminal-tool"),
      input: [{ type: "text", text: "run" }],
    });
    const outputs = await outputsPromise;
    const completed = outputs.filter(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      kind: "event",
      event: {
        type: "item.completed",
        snapshot: {
          item: { output: { content: [{ type: "text", text: "exit code 1" }] } },
          outcome: { status: "failed" },
        },
      },
    });
    await session.close();
  });

  it("emits a completed tool item only once", async () => {
    const transport = {
      onFault: () => undefined,
      runTurn: async (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "tool-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Read file",
            status: "pending",
          },
        } as HermesTransportEvent);
        onEvent({
          type: "tool.update",
          toolCallId: "tool-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            rawOutput: "done",
          },
        } as HermesTransportEvent);
        return { stopReason: "end_turn" as const };
      },
      cancel: async () => undefined,
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = collectUntilTurnCompleted(session.outputs);
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-tool-terminal"),
      input: [{ type: "text", text: "read" }],
    });
    const outputs = await outputsPromise;

    const completed = outputs.filter(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );
    expect(completed).toHaveLength(1);
    await session.close();
  });

  it("terminalizes the active Turn before a transport fault ends the Session", async () => {
    let fault: ((error: HermesTransportError) => void) | undefined;
    const transport = {
      set onFault(handler: (error: HermesTransportError) => void) {
        fault = handler;
      },
      runTurn: (_text: string, onEvent: (event: HermesTransportEvent) => void) => {
        onEvent({
          type: "tool.call",
          toolCallId: "tool-during-fault",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-during-fault",
            title: "Long-running command",
            status: "in_progress",
          },
        } as HermesTransportEvent);
        return new Promise<never>(() => undefined);
      },
      cancel: async () => undefined,
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });

    const outputsPromise = (async () => {
      const outputs: HarnessOutput[] = [];
      for await (const output of session.outputs) outputs.push(output);
      return outputs;
    })();
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-fault"),
      input: [{ type: "text", text: "go" }],
    });
    fault?.(new HermesTransportError("processExited", "Hermes exited"));
    const outputs = await outputsPromise;
    const eventTypes = outputs
      .filter(
        (output): output is Extract<HarnessOutput, { kind: "event" }> => output.kind === "event",
      )
      .map((output) => output.event.type);

    expect(eventTypes).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
      "session.faulted",
    ]);
    const itemCompleted = outputs.find(
      (output) => output.kind === "event" && output.event.type === "item.completed",
    );
    expect(itemCompleted).toMatchObject({
      kind: "event",
      event: { type: "item.completed", snapshot: { outcome: { status: "cancelled" } } },
    });
    const turnCompleted = outputs.find(
      (output) => output.kind === "event" && output.event.type === "turn.completed",
    );
    expect(turnCompleted).toMatchObject({
      kind: "event",
      event: { type: "turn.completed", outcome: { status: "failed" } },
    });
  });
});

describe("HermesSession cancellation", () => {
  it("reports cancellation failure instead of claiming it was requested", async () => {
    let rejectTurn: ((error: Error) => void) | undefined;
    const transport = {
      onFault: () => undefined,
      runTurn: () =>
        new Promise<never>((_resolve, reject) => {
          rejectTurn = reject;
        }),
      cancel: async () => {
        throw new Error("cancel RPC failed");
      },
      close: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
    } as unknown as HermesAcpTransport;
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport,
      open: openResult(),
      onSettle: () => undefined,
    });
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-cancel"),
      input: [{ type: "text", text: "go" }],
    });

    const cancelled = await session.execute({
      type: "turn.cancel",
      turnId: hostTurnIdSchema.parse("turn-cancel"),
    });

    expect(cancelled).toMatchObject({ ok: false, error: { message: "cancel RPC failed" } });
    await expect(
      session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("turn-after-failed-cancel"),
        input: [{ type: "text", text: "must remain blocked" }],
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    rejectTurn?.(new Error("cancelled by test"));
    await session.close();
  });
});

describe("HermesSession live configuration errors", () => {
  it("preserves authentication details from Model selection", async () => {
    const transport = new FakeTurnTransport();
    transport.setModel = async () => {
      throw new HermesTransportError(
        "authenticationRequired",
        "No LLM provider configured for provider=openrouter",
      );
    };
    const session = new HermesSession({
      nativeRef: nativeSessionRefSchema.parse({
        harnessId: "hermes",
        nativeSessionId: "native-session-1",
        formatVersion: 1,
      }),
      transport: transport as unknown as HermesAcpTransport,
      open: openResult(),
      onSettle: () => undefined,
    });
    const model = encodeHermesModelRef("openrouter:test-model");
    if (!model) throw new Error("Expected a valid Hermes Model Ref");

    const selected = await session.execute({ type: "model.select", model });

    expect(selected).toMatchObject({
      ok: false,
      error: {
        code: "authenticationRequired",
        message: "No LLM provider configured for provider=openrouter",
      },
    });
    await session.close();
  });
});
