import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { TraeCnAdapter } from "../src/adapter.js";
import { BridgeClient } from "../src/bridge.js";
import { modelRef } from "../src/models.js";
import type { BridgeInspection } from "../src/protocol.js";

const inspection: BridgeInspection = {
  instanceId: "bridge",
  application: { name: "Trae CN", version: "3.4.14", root: "/app", executable: "/app/trae" },
  workspaceFolders: ["/workspace"],
  agentType: "builder_v3",
  configuration: { modelSelection: "per-request", thinkingSelection: "per-request" },
  models: [
    {
      id: "configured",
      label: "Configured",
      provider: "native",
      multimodal: false,
      thinking: { field: "reasoning_effort_level", options: ["light", "high"] },
    },
    { id: "alternative", label: "Alternative", provider: "native", multimodal: false },
  ],
};
const nativeRef = nativeSessionRefSchema.parse({
  harnessId: "trae-cn",
  nativeSessionId: "session",
  formatVersion: 1,
  locator: {
    applicationRoot: "/app",
    cwd: "/workspace",
    projectId: "project",
    agentType: "builder_v3",
  },
});
const user = {
  chat_session_id: "session",
  message_id: "user",
  message_index: 1,
  role: "user",
  content: [{ type: "text", text_content: "hello" }],
};
const tool = {
  type: "plan_item",
  plan_item: {
    id: "tool",
    tool_call_info: {
      name: "ReadFile",
      params: { path: "/workspace/example" },
      result: { status: "success", data: "FILE CONTENT" },
    },
  },
};
const answer = {
  type: "plan_item",
  plan_item: {
    id: "answer",
    tool_call_info: {
      name: "finish",
      params: { summary: "REAL FINAL ANSWER" },
      result: { status: "success" },
    },
  },
};
const assistant = {
  chat_session_id: "session",
  message_id: "assistant",
  reply_to_message_id: "user",
  message_index: 2,
  role: "assistant",
  status: "completed",
  model: { config_name: "configured", reasoning_effort_level: "high" },
  content: { messages: [tool, answer] },
};
const terminal = {
  sessionId: "session",
  projectId: "project",
  workspaceFolders: ["/workspace"],
  status: 6,
  items: [user, assistant],
};

function fixture() {
  const client = {
    inspect: vi.fn(async () => inspection),
    call: vi.fn(async (method: string, args: Record<string, unknown>) => {
      if (method === "snapshot") return terminal;
      if (method === "prepareModel")
        return {
          agentType: inspection.agentType,
          modelId: args.modelId,
          ...(args.thinking ? { thinking: args.thinking } : {}),
        };
      throw new Error(`Unexpected native write: ${method}`);
    }),
    subscribe: vi.fn(async (_: unknown, listener: { error(error: unknown): void }) => {
      listener.error(new Error("Native work already finished"));
      return () => undefined;
    }),
    close: vi.fn(),
  };
  vi.spyOn(BridgeClient, "connect").mockResolvedValue({
    client: client as unknown as BridgeClient,
    inspection,
  });
  return { client, adapter: new TraeCnAdapter() };
}

afterEach(() => vi.restoreAllMocks());

describe("TRAE CN recovery regressions", () => {
  it("fills durable answers and tools before completing when native work finishes before subscription", async () => {
    const { client, adapter } = fixture();
    // Keep an earlier completed Turn visible, but exclude the pending last one.
    const pending = {
      ...terminal,
      status: 3,
      items: [
        { ...user, message_id: "earlier", message_index: -1 },
        {
          ...assistant,
          message_id: "earlier-answer",
          reply_to_message_id: "earlier",
          message_index: 0,
        },
        user,
      ],
    };
    client.call.mockResolvedValueOnce(pending);
    try {
      const opened = await adapter.open({ kind: "resume", cwd: "/workspace", nativeRef });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(client.subscribe).not.toHaveBeenCalled();
      expect(await session.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          turns: [{ nativeTurnRef: { nativeTurnKey: "earlier" } }],
        },
      });
      const before = await session.readSnapshot();
      expect(before.ok && before.value.turns).toHaveLength(1);
      const outputs: HarnessOutput[] = [];
      for await (const output of session.outputs) {
        outputs.push(output);
        if (output.kind === "event" && output.event.type === "turn.completed") break;
      }
      expect(outputs[0]).toMatchObject({
        event: { type: "turn.autonomous.started", input: [{ type: "text", text: "hello" }] },
      });
      expect(outputs.at(-1)).toMatchObject({
        event: {
          type: "turn.completed",
          nativeTurnRef: { nativeTurnKey: "user" },
          outcome: { status: "succeeded" },
        },
      });
      expect(outputs).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({ type: "agentMessage", text: "REAL FINAL ANSWER" }),
            }),
          }),
        }),
      );
      expect(outputs).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "item.completed",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({
                type: "toolExecution",
                toolName: "ReadFile",
                output: { content: [{ type: "text", text: "FILE CONTENT" }] },
              }),
            }),
          }),
        }),
      );
      expect(client.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("does not resurrect old Thinking after switching away and back without sending", async () => {
    const { adapter } = fixture();
    try {
      const opened = await adapter.open({ kind: "resume", cwd: "/workspace", nativeRef });
      if (!opened.ok) throw new Error(opened.error.message);
      const session = opened.value;
      expect(session.initialState.effectiveThinkingOptionId).toBeDefined();
      expect(
        await session.execute({
          type: "model.select",
          model: modelRef("builder_v3", "alternative"),
        }),
      ).toMatchObject({ ok: true });
      expect(
        await session.execute({
          type: "model.select",
          model: modelRef("builder_v3", "configured"),
        }),
      ).toMatchObject({ ok: true });
      const beforeRestart = await session.readSnapshot();
      if (!beforeRestart.ok) throw new Error(beforeRestart.error.message);
      expect(beforeRestart.value.state?.effectiveThinkingOptionId).toBeUndefined();
      await session.close();
      const resumed = await adapter.open({
        kind: "resume",
        cwd: "/workspace",
        nativeRef,
        model: modelRef("builder_v3", "configured"),
      });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState.effectiveThinkingOptionId).toBeUndefined();
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          state: { effectiveModel: modelRef("builder_v3", "configured") },
        },
      });
    } finally {
      await adapter.close();
    }
  });
});
