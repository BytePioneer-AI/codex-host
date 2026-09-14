import { describe, expect, it } from "vitest";
import {
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  hostInteractionIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import { QoderAdapter } from "../src/adapter.js";
import { mapQoderJsonlSnapshot } from "../src/history.js";
import { parseQoderListModels, qoderModelRef } from "../src/models.js";
import type { QoderQuery, QoderQueryFactory } from "../src/sdk-transport.js";

const LIST_MODELS = `MODEL
Auto
Performance
Qwen3.8-Max
`;

const STATUS = `Version: 1.1.51
Username: tester
Email: tester@example.com
`;

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
  interrupt?: () => Promise<void>;
  onPrompt?: (prompt: unknown) => void;
}): QoderQueryFactory {
  return (input) => {
    const query: QoderQuery = {
      async initializationResult() {
        return { session_id: "11111111-1111-1111-1111-111111111111" };
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
      async *[Symbol.asyncIterator]() {
        for await (const value of input.prompt) {
          handlers.onPrompt?.(value);
          for (const message of handlers.messages ?? [
            {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
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
  it("parses --list-models into a Host catalog", () => {
    const catalog = parseQoderListModels(LIST_MODELS);
    expect(catalog.models.map((model) => model.label)).toEqual([
      "Auto",
      "Performance",
      "Qwen3.8-Max",
    ]);
    expect(catalog.defaultModel).toEqual(qoderModelRef("Auto"));
  });

  it("inspects without opening a user session", async () => {
    const adapter = new QoderAdapter({
      command: process.execPath,
      listModels: async () => LIST_MODELS,
      readStatus: async () => STATUS,
    });
    const inspection = harnessInspectionSchema.parse(await adapter.inspect({ cwd: process.cwd() }));
    expect(inspection.status).toBe("ready");
    if (inspection.status === "ready") {
      expect(inspection.capabilities.history.rollbackLastTurn).toBe(false);
      expect(inspection.permissionModes?.defaultModeId).toBe("default");
    }
    await adapter.close();
  });

  it("creates a session, streams a turn, and rejects rollback", async () => {
    const adapter = new QoderAdapter({
      command: process.execPath,
      listModels: async () => LIST_MODELS,
      readStatus: async () => STATUS,
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
    if (!rollback.ok) expect(rollback.error.code).toBe("unsupported");
    await opened.value.close();
    await done;
    await adapter.close();
  });

  it("confirms live permission mode writes", async () => {
    const selected: string[] = [];
    const adapter = new QoderAdapter({
      command: process.execPath,
      listModels: async () => LIST_MODELS,
      readStatus: async () => STATUS,
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
      listModels: async () => LIST_MODELS,
      readStatus: async () => STATUS,
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
    const adapter = new QoderAdapter({
      command: process.execPath,
      listModels: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary native failure");
        return LIST_MODELS;
      },
      readStatus: async () => STATUS,
    });
    const first = await adapter.inspect({ cwd: process.cwd() });
    expect(first.status).toBe("error");
    const second = await adapter.inspect({ cwd: process.cwd() });
    expect(second.status).toBe("ready");
    expect(calls).toBe(2);
    await adapter.close();
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
      listModels: async () => LIST_MODELS,
      readStatus: async () => STATUS,
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
