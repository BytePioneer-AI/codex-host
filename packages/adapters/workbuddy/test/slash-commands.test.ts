import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import {
  CodeBuddyError,
  type CodeBuddyClient,
  type CodeBuddyClientFactory,
} from "@codexhost/adapter-codebuddy";
import { WORKBUDDY_COMMAND_CATALOG } from "../src/common.js";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const adapters: WorkBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

const configOptions = [
  {
    id: "model",
    currentValue: "native/model",
    options: [{ value: "native/model", name: "Native Model" }],
  },
  {
    id: "mode",
    currentValue: "default",
    options: ["default", "plan", "fullAccess"].map((value) => ({ value, name: value })),
  },
  {
    id: "thought_level",
    currentValue: "low",
    options: ["low", "high"].map((value) => ({ value, name: value })),
  },
];

function nativeFixture(compactionStatus: "completed" | "failed" | "cancelled" = "completed") {
  const history: Record<string, unknown>[] = [];
  const prompts: string[] = [];
  let sequence = 0;
  const clientFactory: CodeBuddyClientFactory = (context) =>
    ({
      initialize: async () => ({ protocolVersion: 1 }),
      open: async (_cwd, sessionId) => {
        context.handlers.update({
          sessionId: sessionId ?? "workbuddy-native",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "compact", description: "Compact" },
              { name: "init", description: "Initialize" },
              { name: "cost", description: "Cost" },
              { name: "review", description: "Review", input: { hint: "[target]" } },
              { name: "fork", description: "Fork" },
              { name: "bad/name", description: "Malformed" },
            ],
          },
        } as never);
        return { sessionId: sessionId ?? "workbuddy-native", configOptions };
      },
      configure: async (_sessionId, id, value) => ({
        configOptions: configOptions.map((option) => ({
          ...option,
          currentValue: option.id === id ? value : option.currentValue,
        })),
      }),
      prompt: async (_sessionId, input) => {
        prompts.push(input);
        if (input.startsWith("/compact")) {
          const userId = `compact-${++sequence}`;
          history.push(
            {
              type: "message",
              role: "user",
              id: userId,
              parentId: history.at(-1)?.id,
              providerData: { agent: "compact" },
              content: "Native compaction instructions",
            },
            {
              type: "message",
              role: "assistant",
              id: `summary-${sequence}`,
              parentId: userId,
              status: compactionStatus,
              providerData: {
                agent: "compact",
                isCompactInternal: true,
                isCompacted: compactionStatus === "completed",
                compactType: "user-command",
              },
              content: "Native summary",
            },
          );
          context.handlers.update({
            sessionId: "workbuddy-native",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Native summary" },
              _meta: { "codebuddy.ai/isCompactInternal": true },
            },
          } as never);
          return {
            stopReason: "end_turn",
            userMessageId: userId,
            _meta: { "codebuddy.ai/outcome": "SUCCESS" },
          };
        }
        context.handlers.update({
          sessionId: "workbuddy-native",
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `local-${sequence}`,
            content: { type: "text", text: `Result ${input}` },
          },
        } as never);
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
      answer: async () => {},
      close: async () => {},
    }) satisfies CodeBuddyClient;
  return {
    clientFactory,
    prompts,
    readHistory: async () => {
      if (!history.length) throw new CodeBuddyError("sessionNotFound", "Missing fixture history");
      return history.map((row) => JSON.stringify(row)).join("\n");
    },
  };
}

describe("WorkBuddy native slash commands", () => {
  it("advertises the fixed native commands before opening a Session", () => {
    const adapter = new WorkBuddyAdapter({ clientFactory: nativeFixture().clientFactory });
    adapters.push(adapter);
    expect(adapter.commandCatalog).toEqual(WORKBUDDY_COMMAND_CATALOG);
    expect(adapter.commandCatalog?.commands.map(({ id, invocation }) => [id, invocation])).toEqual([
      ["workbuddy.compact", "/compact"],
      ["workbuddy.init", "/init"],
    ]);
  });

  it("keeps the static safe catalog when native discovery reports extra commands", async () => {
    const native = nativeFixture();
    const adapter = new WorkBuddyAdapter(native);
    adapters.push(adapter);
    const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
    if (!opened.ok) throw new Error(opened.error.message);
    const session = opened.value;
    const outputs: HarnessOutput[] = [];
    void (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();

    expect(await session.commands?.list()).toMatchObject({
      value: {
        commands: [
          { id: "workbuddy.compact", argumentMode: "text" },
          { id: "workbuddy.init", argumentMode: "none" },
        ],
      },
    });
    expect(
      await session.commands?.execute({
        turnId: hostTurnIdSchema.parse("bad-init"),
        commandId: "workbuddy.init",
        arguments: { text: "unexpected" },
      }),
    ).toMatchObject({ error: { code: "invalidRequest" } });
    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("unsafe-fork"),
        input: [{ type: "text", text: "/fork other" }],
      }),
    ).toMatchObject({ error: { code: "unsupported" } });

    const turnId = hostTurnIdSchema.parse("compact-turn");
    expect(
      await session.commands?.execute({
        turnId,
        commandId: "workbuddy.compact",
        arguments: { text: "retain decisions" },
      }),
    ).toEqual({ ok: true, value: { turnId } });
    await vi.waitFor(() =>
      expect(
        outputs.filter(
          (output) => output.kind === "event" && output.event.type === "turn.completed",
        ),
      ).toHaveLength(1),
    );
    expect(native.prompts).toEqual(["/compact retain decisions"]);
    expect(outputs).toEqual(
      expect.arrayContaining([
        {
          kind: "event",
          event: {
            type: "item.started",
            turnId,
            item: { type: "contextCompaction", itemId: `compact-${turnId}` },
          },
        },
        {
          kind: "event",
          event: {
            type: "item.completed",
            turnId,
            snapshot: {
              item: { type: "contextCompaction", itemId: `compact-${turnId}` },
              outcome: { status: "succeeded" },
            },
          },
        },
      ]),
    );
    expect(await session.readSnapshot()).toMatchObject({
      value: {
        turns: [
          {
            input: [{ text: "/compact" }],
            items: [{ item: { type: "contextCompaction" }, outcome: { status: "succeeded" } }],
          },
        ],
      },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "uses the persisted %s compaction outcome for live Item and Turn completion",
    async (status) => {
      const native = nativeFixture(status);
      const adapter = new WorkBuddyAdapter(native);
      adapters.push(adapter);
      const opened = await adapter.open({ kind: "create", cwd: process.cwd() });
      if (!opened.ok) throw new Error(opened.error.message);
      const outputs: HarnessOutput[] = [];
      void (async () => {
        for await (const output of opened.value.outputs) outputs.push(output);
      })();
      const turnId = hostTurnIdSchema.parse(`compact-${status}`);
      expect(
        await opened.value.commands?.execute({
          turnId,
          commandId: "workbuddy.compact",
        }),
      ).toEqual({ ok: true, value: { turnId } });
      await vi.waitFor(() =>
        expect(
          outputs.filter(
            (output) => output.kind === "event" && output.event.type === "turn.completed",
          ),
        ).toHaveLength(1),
      );
      expect(outputs).toContainEqual({
        kind: "event",
        event: expect.objectContaining({
          type: "turn.completed",
          turnId,
          outcome: expect.objectContaining({ status }),
        }),
      });
      expect(outputs).toContainEqual({
        kind: "event",
        event: expect.objectContaining({
          type: "item.completed",
          turnId,
          snapshot: expect.objectContaining({
            item: expect.objectContaining({ type: "contextCompaction" }),
            outcome: expect.objectContaining({ status }),
          }),
        }),
      });
    },
  );
});
