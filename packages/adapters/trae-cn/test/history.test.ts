import { describe, expect, it } from "vitest";
import { projectHistory, projectPlanItem } from "../src/history.js";
import { confirmedModel, modelCatalog, modelRef, nativeModelId } from "../src/models.js";
import type { BridgeInspection } from "../src/protocol.js";

const inspection: BridgeInspection = {
  instanceId: "instance",
  application: { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" },
  workspaceFolders: ["/workspace"],
  agentType: "builder_v3",
  models: [
    {
      id: "custom_provider//native-model",
      label: "Configured Model",
      provider: "provider",
      multimodal: false,
    },
  ],
};
const user = {
  chat_session_id: "session",
  message_id: "native-user",
  message_index: 1,
  role: "user",
  content: JSON.stringify([{ type: "text", text_content: "hello" }]),
};
const plan = {
  id: "plan",
  reasoning_content: "thinking",
  thought: "progress",
  timing: { tool_call_started_at_ms: 100, tool_call_finished_at_ms: 120 },
  tool_call_info: { name: "finish", params: { summary: "answer" }, result: { status: "success" } },
  agent_status: { status: "completed" },
};
const reply = {
  chat_session_id: "session",
  message_id: "native-assistant",
  reply_to_message_id: user.message_id,
  message_index: 2,
  role: "assistant",
  status: "completed",
  model: { config_name: inspection.models[0]?.id },
  chat_start_time: 1000,
  chat_end_time: 2000,
  content: JSON.stringify({ task_id: "task", messages: [{ type: "plan_item", plan_item: plan }] }),
};
const snapshot = (items: unknown[]) => ({ sessionId: "session", items });

describe("TRAE CN native model references", () => {
  it("advertises native model selections with opaque IDs and no implicit default", () => {
    const catalog = modelCatalog(inspection);
    expect(catalog.defaultModel).toBeUndefined();
    expect(catalog.models[0]?.ref.id).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(
      nativeModelId(inspection, modelRef(inspection.agentType, "custom_provider//native-model")),
    ).toBe("custom_provider//native-model");
    expect(modelRef("solo_agent", "custom_provider//native-model")).not.toEqual(
      catalog.models[0]?.ref,
    );
    expect(() => nativeModelId(inspection, modelRef(inspection.agentType, "removed"))).toThrow(
      "currently available",
    );
  });

  it("does not confuse a request or internal runtime alias with native-confirmed configuration", () => {
    expect(confirmedModel({ model_name: "internal__dev" }, "builder_v3")).toBeUndefined();
    expect(confirmedModel({ config_name: "configured" }, "builder_v3")).toEqual(
      modelRef("builder_v3", "configured"),
    );
  });
});

describe("TRAE CN native history projection", () => {
  it("preserves native identities, separate content types, outcomes and wall-clock timestamps", () => {
    const first = projectHistory(snapshot([reply, user]), "session", inspection.agentType);
    const second = projectHistory(snapshot([user, reply]), "session", inspection.agentType);
    expect(first).toEqual(second);
    expect(first.turns[0]).toMatchObject({
      nativeTurnRef: {
        harnessId: "trae-cn",
        nativeSessionId: "session",
        nativeTurnKey: "native-user",
        formatVersion: 1,
      },
      input: [{ type: "text", text: "hello" }],
      outcome: { status: "succeeded" },
      startedAtMs: 1000,
      completedAtMs: 2000,
      items: [
        { item: { type: "reasoning", text: "thinking" } },
        { item: { type: "agentMessage", text: "answer", phase: "final_answer" } },
      ],
    });
    expect(first.turns[0]?.model).toEqual(
      modelRef(inspection.agentType, "custom_provider//native-model"),
    );
  });

  it.each(["canceled", "failed", "in_progress"])(
    "preserves %s instead of inferring completion from answer text",
    (status) => {
      const result = projectHistory(
        snapshot([user, { ...reply, status, error: { message: "native failure" } }]),
        "session",
        inspection.agentType,
      );
      expect(result.turns[0]?.outcome.status).toBe(
        status === "canceled" ? "cancelled" : status === "failed" ? "failed" : "unknown",
      );
    },
  );

  it("leaves a durable unanswered user message unknown", () => {
    expect(
      projectHistory(snapshot([user]), "session", inspection.agentType).turns[0],
    ).toMatchObject({ input: [{ text: "hello" }], items: [], outcome: { status: "unknown" } });
  });

  it("keeps real tool arguments and output without inventing missing durable output", () => {
    const tool = {
      ...plan,
      thought: "",
      reasoning_content: "",
      tool_call_info: {
        name: "Read",
        params: { file_path: "/workspace/fixture.txt" },
        result: { status: "success" },
      },
    };
    expect(projectPlanItem(tool)).toEqual([
      {
        item: {
          type: "toolExecution",
          itemId: "plan.tool",
          toolName: "Read",
          arguments: { file_path: "/workspace/fixture.txt" },
          durationMs: 20,
        },
        outcome: { status: "succeeded" },
      },
    ]);
    expect(
      projectPlanItem({
        ...tool,
        tool_call_info: {
          ...tool.tool_call_info,
          result: { status: "success", data: "native output", is_truncated: true },
        },
      })[0]?.item,
    ).toMatchObject({
      output: { content: [{ type: "text", text: "native output" }], truncated: true },
    });
  });

  it("does not start a tool with incomplete streamed arguments or settle running reasoning", () => {
    const partial = projectPlanItem({
      id: "partial",
      reasoning_content: "first",
      tool_call_info: { name: "Read", params: null },
    });
    expect(partial).toEqual([
      { item: { type: "reasoning", itemId: "partial.reasoning_content", text: "first" } },
    ]);
  });

  it("rejects foreign sessions, duplicated identities and orphan replies", () => {
    expect(() =>
      projectHistory(
        snapshot([{ ...user, chat_session_id: "another" }]),
        "session",
        inspection.agentType,
      ),
    ).toThrow("Invalid native history");
    expect(() => projectHistory(snapshot([user, user]), "session", inspection.agentType)).toThrow(
      "Duplicate native history",
    );
    expect(() => projectHistory(snapshot([reply]), "session", inspection.agentType)).toThrow(
      "corresponding user",
    );
    expect(() =>
      projectHistory(
        snapshot([user, reply, { ...reply, message_id: "second" }]),
        "session",
        inspection.agentType,
      ),
    ).toThrow("autonomous Turn");
  });

  it("does not silently drop an unsupported task item or non-text user input", () => {
    expect(() =>
      projectHistory(
        snapshot([{ ...user, content: JSON.stringify([{ type: "image" }]) }]),
        "session",
        inspection.agentType,
      ),
    ).toThrow("non-text");
    expect(() =>
      projectHistory(
        snapshot([
          user,
          { ...reply, content: JSON.stringify({ messages: [{ type: "unknown" }] }) },
        ]),
        "session",
        inspection.agentType,
      ),
    ).toThrow("Unsupported native task");
  });
});
