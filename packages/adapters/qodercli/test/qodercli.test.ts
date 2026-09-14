import { describe, expect, it } from "vitest";
import {
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import { QoderAdapter } from "../src/adapter.js";
import { mapQoderJsonlSnapshot } from "../src/history.js";
import { parseQoderSdkModels, qoderModelRef } from "../src/models.js";
import type { QoderQuery, QoderQueryFactory } from "../src/sdk-transport.js";

const SDK_MODELS = [
  {
    value: "Auto",
    displayName: "Auto",
    isDefault: true,
    isReasoning: true,
    efforts: ["low", "medium", "high", "max"],
    supportsDisabled: true,
  },
  { value: "Performance", displayName: "Performance", isReasoning: true, efforts: ["high"] },
  { value: "Qwen3.8-Max", displayName: "Qwen3.8-Max" },
];

function collect(session: { outputs: AsyncIterable<HarnessOutput> }) {
  const output: HarnessOutput[] = [];
  const done = (async () => {
    for await (const item of session.outputs) output.push(item);
  })();
  return { output, done };
}

function fakeQuery(handlers: {
  messages?: unknown[];
  setModel?: (model: string) => Promise<void>;
  setPermissionMode?: (mode: string) => Promise<void>;
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  interrupt?: () => Promise<void>;
  onPrompt?: (prompt: unknown) => void;
}): QoderQueryFactory {
  return (input) => {
    const query: QoderQuery = {
      async initializationResult() {
        return { models: SDK_MODELS };
      },
      async interrupt() {
        await handlers.interrupt?.();
      },
      close() {},
      async setModel(model) {
        await handlers.setModel?.(model);
      },
      async setPermissionMode(mode) {
        await handlers.setPermissionMode?.(mode);
      },
      async applyFlagSettings(settings) {
        await handlers.applyFlagSettings?.(settings);
      },
      async getContextUsage() {
        return { contextWindow: { usedPercentage: 12 } };
      },
      async *[Symbol.asyncIterator]() {
        for await (const value of input.prompt) {
          handlers.onPrompt?.(value);
          for (const message of handlers.messages ?? [
            {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "thinking_delta", text: "plan" },
              },
            },
            {
              type: "stream_event",
              event: { delta: { type: "text_delta", text: "ok" } },
            },
            {
              type: "assistant",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", text: "plan" },
                  { type: "text", text: "ok" },
                ],
              },
            },
            { type: "result", subtype: "success" },
          ]) {
            yield message;
          }
        }
      },
    };
    return query;
  };
}

describe("Qoder CLI adapter", () => {
  it("parses SDK Model catalog", () => {
    const catalog = parseQoderSdkModels(SDK_MODELS);
    expect(catalog.models.map((model) => model.label)).toEqual([
      "Auto",
      "Performance",
      "Qwen3.8-Max",
    ]);
    expect(catalog.defaultModel).toEqual(qoderModelRef("Auto"));
  });

  it("inspects through the SDK handshake without sending a Prompt", async () => {
    let persistSession: unknown;
    let promptConsumed = false;
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: (input) => {
        persistSession = (input.options as { persistSession?: boolean }).persistSession;
        return fakeQuery({
          onPrompt: () => {
            promptConsumed = true;
          },
        })(input);
      },
    });
    const inspection = harnessInspectionSchema.parse(await adapter.inspect({ cwd: process.cwd() }));
    expect(inspection.status).toBe("ready");
    if (inspection.status === "ready") {
      expect(inspection.catalog.models.map((model) => model.label)).toEqual([
        "Auto",
        "Performance",
        "Qwen3.8-Max",
      ]);
      expect(inspection.capabilities.history.rollbackLastTurn).toBe(true);
      expect(inspection.capabilities.configuration.selectThinkingOption).toBe(true);
      expect(inspection.capabilities.subagents?.observe).toBe(true);
      expect(inspection.catalog.thinkingOptions.map((option) => option.id)).toEqual([
        "off",
        "low",
        "medium",
        "high",
        "max",
      ]);
      expect(inspection.permissionModes?.defaultModeId).toBe("default");
    }
    expect(persistSession).toBe(false);
    expect(promptConsumed).toBe(false);
    await adapter.close();
  });

  it("creates a session, streams a turn, and rejects rollback", async () => {
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({}),
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const { output, done } = collect(opened.value);
    const turnId = hostTurnIdSchema.parse("turn-one");
    const started = await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "hello" }],
    });
    expect(started.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      output.some((item) => item.kind === "event" && item.event.type === "turn.completed"),
    ).toBe(true);
    const rollback = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef: nativeSessionRefSchema.parse({
        harnessId: "qodercli",
        nativeSessionId: "11111111-1111-1111-1111-111111111111",
        formatVersion: 1,
      }),
      cwd: process.cwd(),
    });
    expect(rollback.ok).toBe(false);
    if (!rollback.ok) expect(rollback.error.code).toBe("invalidRequest");
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("confirms live permission mode writes", async () => {
    const selected: string[] = [];
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({
        setPermissionMode: async (mode) => {
          selected.push(mode);
        },
      }),
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const { done } = collect(opened.value);
    const result = await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("acceptEdits"),
    });
    expect(result.ok).toBe(true);
    expect(selected).toEqual(["acceptEdits"]);
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("selects Thinking through applyFlagSettings", async () => {
    const settings: Record<string, unknown>[] = [];
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({
        applyFlagSettings: async (value) => {
          settings.push(value);
        },
      }),
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const { done } = collect(opened.value);
    const result = await opened.value.execute({
      type: "thinking.select",
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    expect(result.ok).toBe(true);
    expect(settings).toEqual([{ alwaysThinkingEnabled: true, effortLevel: "high" }]);
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("rolls back the last Turn by forking the retained prefix", async () => {
    const sourceRef = nativeSessionRefSchema.parse({
      harnessId: "qodercli",
      nativeSessionId: "source-session",
      formatVersion: 1,
    });
    const turn = (id: string) => ({
      nativeTurnRef: nativeTurnRefSchema.parse({
        harnessId: "qodercli",
        nativeSessionId: sourceRef.nativeSessionId,
        nativeTurnKey: id,
        formatVersion: 1,
      }),
      checkpoint: nativeCheckpointRefSchema.parse({
        harnessId: "qodercli",
        nativeSessionId: sourceRef.nativeSessionId,
        checkpointId: id,
        formatVersion: 1,
      }),
      input: [{ type: "text" as const, text: id }],
      items: [],
      outcome: { status: "unknown" as const, reason: "historical" },
    });
    const sourceTurns = [turn("turn-a"), turn("turn-b")];
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({}),
      history: {
        readSnapshot: async (nativeRef) =>
          nativeRef.nativeSessionId === "forked-session"
            ? {
                turns: [
                  {
                    ...turn("turn-a"),
                    nativeTurnRef: nativeTurnRefSchema.parse({
                      harnessId: "qodercli",
                      nativeSessionId: "forked-session",
                      nativeTurnKey: "forked-a",
                      formatVersion: 1,
                    }),
                    checkpoint: nativeCheckpointRefSchema.parse({
                      harnessId: "qodercli",
                      nativeSessionId: "forked-session",
                      checkpointId: "forked-a",
                      formatVersion: 1,
                    }),
                  },
                ],
              }
            : { turns: sourceTurns },
        forkSession: async (input) => {
          expect(input.upToMessageId).toBe("turn-a");
          return { sessionId: "forked-session" };
        },
        deleteSession: async () => {
          throw new Error("should not delete a valid fork");
        },
      },
    });
    const opened = await adapter.open({
      kind: "rollbackLastTurn",
      sourceRef,
      cwd: process.cwd(),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const { done } = collect(opened.value);
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("publishes Usage from a result message", async () => {
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({
        messages: [
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          },
          {
            type: "result",
            subtype: "success",
            total_credits: 1.5,
            usage: { input_tokens: 10, output_tokens: 4 },
          },
        ],
      }),
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const { output, done } = collect(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-usage"),
      input: [{ type: "text", text: "hi" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      output.some(
        (item) =>
          item.kind === "event" &&
          item.event.type === "session.usage.changed" &&
          item.event.usage?.totalCredits === 1.5,
      ),
    ).toBe(true);
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("maps jsonl history into Host turns", () => {
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "qodercli",
      nativeSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      formatVersion: 1,
    });
    const snapshot = mapQoderJsonlSnapshot(
      nativeRef,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          promptId: "prompt-1",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "performance",
            content: [{ type: "text", text: "hi" }],
          },
        }),
      ].join("\n"),
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.input[0]?.text).toBe("hello");
    expect(snapshot.turns[0]?.items[0]?.item).toMatchObject({ type: "agentMessage", text: "hi" });
    expect(snapshot.turns[0]?.checkpoint).toEqual(
      nativeCheckpointRefSchema.parse({
        harnessId: "qodercli",
        nativeSessionId: nativeRef.nativeSessionId,
        checkpointId: "prompt-1",
        formatVersion: 1,
      }),
    );
  });

  it("does not duplicate streamed assistant text", async () => {
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: fakeQuery({
        messages: [
          {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "Hel" } },
          },
          {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "lo" } },
          },
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          },
          { type: "result", subtype: "success" },
        ],
      }),
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const { output, done } = collect(opened.value);
    await opened.value.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("turn-stream"),
      input: [{ type: "text", text: "hi" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const text = output
      .flatMap((item) => {
        if (item.kind !== "event") return [];
        if (item.event.type === "item.started" && item.event.item.type === "agentMessage") {
          return [item.event.item.text];
        }
        if (item.event.type === "item.updated" && item.event.update.type === "text.append") {
          return [item.event.update.text];
        }
        return [];
      })
      .join("");
    expect(text).toBe("Hello");
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("does not treat tool results as new historical turns", () => {
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "qodercli",
      nativeSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      formatVersion: 1,
    });
    const snapshot = mapQoderJsonlSnapshot(
      nativeRef,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          promptId: "prompt-1",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "a.ts" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-tool",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }],
          },
        }),
      ].join("\n"),
    );
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.items).toHaveLength(1);
  });

  it("does not cache failed inspections", async () => {
    let calls = 0;
    const retryAdapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: (input) => {
        calls += 1;
        if (calls === 1) {
          return {
            async initializationResult() {
              throw new Error("temporary native failure");
            },
            async interrupt() {},
            close() {},
            async *[Symbol.asyncIterator]() {},
          };
        }
        return fakeQuery({})(input);
      },
    });
    const first = await retryAdapter.inspect({ cwd: process.cwd() });
    expect(first.status).toBe("error");
    const second = await retryAdapter.inspect({ cwd: process.cwd() });
    expect(second.status).toBe("ready");
    expect(calls).toBe(2);
    await retryAdapter.close();
  });

  it("accepts tool approval during a turn", async () => {
    const factory: QoderQueryFactory = (input) => {
      const canUseTool = (
        input.options as {
          canUseTool: (
            toolName: string,
            toolInput: Record<string, unknown>,
            context: { toolUseID: string; signal: AbortSignal; title?: string },
          ) => Promise<unknown>;
        }
      ).canUseTool;
      return fakeQuery({
        onPrompt: () => {
          void canUseTool(
            "Read",
            { path: "a.ts" },
            {
              toolUseID: "call-1",
              signal: new AbortController().signal,
              title: "Read a.ts",
            },
          );
        },
        messages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "a.ts" } }],
            },
          },
        ],
      })(input);
    };
    const adapter = new QoderAdapter({
      command: process.execPath,
      queryFactory: factory,
      readSnapshot: () => ({ turns: [] }),
    });
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const { output, done } = collect(opened.value);
    const turnId = hostTurnIdSchema.parse("turn-tool");
    await opened.value.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text: "read it" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const interaction = output.find((item) => item.kind === "interaction");
    expect(interaction?.kind).toBe("interaction");
    if (interaction?.kind !== "interaction" || interaction.interaction.type !== "approval") {
      throw new Error("expected approval");
    }
    const responded = await opened.value.execute({
      type: "interaction.respond",
      interactionId: hostInteractionIdSchema.parse(interaction.interaction.interactionId),
      response: { type: "approval", actionId: "allow-once" },
    });
    expect(responded.ok).toBe(true);
    await opened.value.close();
    await done;
    await adapter.close();
  });
});
