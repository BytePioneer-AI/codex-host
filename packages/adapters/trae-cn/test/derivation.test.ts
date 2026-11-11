import { describe, expect, it, vi } from "vitest";
import { nativeSessionRefSchema, nativeCheckpointRefSchema } from "@codexhost/shared-contracts";
import type { BridgeClient } from "../src/bridge.js";
import type { BridgeInspection } from "../src/protocol.js";
import { deriveSession } from "../src/derivation.js";
import { modelRef, thinkingOptionId } from "../src/models.js";
import { permissionModeRef } from "../src/permissions.js";
const inspection: BridgeInspection = {
  instanceId: "instance",
  application: { name: "Trae CN", root: "/app", executable: "/app/trae", version: "fixture" },
  workspaceFolders: ["/workspace"],
  agentType: "builder_v3",
  models: [{ id: "configured", label: "Configured", provider: "native", multimodal: false }],
  history: { forkFromMessage: true, forkFromSession: true },
};
const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "trae-cn",
  nativeSessionId: "source",
  formatVersion: 1,
  locator: {
    applicationRoot: "/app",
    cwd: "/workspace",
    projectId: "project",
    agentType: "builder_v3",
  },
});
const checkpoint = (id: string) =>
  nativeCheckpointRefSchema.parse({
    harnessId: "trae-cn",
    nativeSessionId: "source",
    checkpointId: id,
    formatVersion: 1,
  });
function messages(sessionId: string, count: number, copied = false) {
  return Array.from({ length: count }, (_, n) => [
    {
      chat_session_id: sessionId,
      message_id: `${copied ? "copy-" : ""}u${n}`,
      role: "user",
      message_index: 2 * n,
      content: JSON.stringify([{ type: "text", text_content: `question ${n}` }]),
    },
    {
      chat_session_id: sessionId,
      message_id: `${copied ? "copy-" : ""}a${n}`,
      role: "assistant",
      message_index: 2 * n + 1,
      reply_to_message_id: `${copied ? "copy-" : ""}u${n}`,
      status: "completed",
      model: { config_name: "configured" },
      content: JSON.stringify({
        messages: [
          {
            type: "plan_item",
            plan_item: {
              id: `plan${n}`,
              tool_call_info: {
                name: "finish",
                params: { summary: `answer ${n}` },
                result: { status: "success" },
              },
            },
          },
        ],
      }),
    },
  ]).flat();
}
function setup(count = 2) {
  const source = {
    sessionId: "source",
    projectId: "project",
    workspaceFolders: ["/workspace"],
    status: 5,
    items: messages("source", count),
  };
  let copiedCount = 0;
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "snapshot")
      return input.sessionId === "source"
        ? structuredClone(source)
        : { ...source, sessionId: "derived", items: messages("derived", copiedCount, true) };
    if (method === "fork") {
      copiedCount = Number(String(input.messageId).slice(1)) + 1;
      return { sessionId: "derived", projectId: "project" };
    }
    if (method === "create") {
      copiedCount = 0;
      return { sessionId: "derived", projectId: "project" };
    }
    throw new Error("Unexpected write");
  });
  return { source, call, client: { call } as unknown as BridgeClient };
}
describe("TRAE CN public history derivation", () => {
  it("rejects copying background executions before writes but permits a sole-Turn empty rollback", async () => {
    for (const count of [1, 2]) {
      const test = setup(count);
      const reply = test.source.items[1];
      if (!reply) throw new Error("Missing fixture reply");
      const plan = {
        id: "background",
        reply_to_message_id: "u0",
        tool_call_info: {
          name: "RunCommand",
          params: { command: "echo OK", cwd: "/workspace", blocking: false },
          result: { status: "success", data: { command_id: "background-command" } },
        },
      };
      Object.assign(reply, {
        content: JSON.stringify({ messages: [{ type: "plan_item", plan_item: plan }] }),
        commandStatuses: [
          {
            messageId: "u0",
            planItemId: "background",
            commandId: "background-command",
            status: "succeeded",
            output: "OK",
            outputTruncated: false,
            exitCode: 0,
          },
        ],
      });
      await expect(
        deriveSession(test.client, inspection, {
          kind: "fork",
          sourceRef,
          checkpoint: checkpoint("a0"),
          cwd: "/workspace",
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      if (count === 1) {
        expect(
          await deriveSession(test.client, inspection, {
            kind: "rollbackLastTurn",
            sourceRef,
            cwd: "/workspace",
          }),
        ).toMatchObject({ nativeRef: { nativeSessionId: "derived" } });
        expect(test.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
          ["create", { cwd: "/workspace", title: "CodexHost rollback" }],
        ]);
      } else {
        await expect(
          deriveSession(test.client, inspection, {
            kind: "rollbackLastTurn",
            sourceRef,
            cwd: "/workspace",
          }),
        ).rejects.toMatchObject({ code: "unsupported" });
        expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      }
    }
  });
  it.each([1, 2])(
    "preserves an explicit permission mode on %s-Turn rollback and validates it before writes",
    async (count) => {
      const test = setup(count),
        catalog: BridgeInspection = {
          ...inspection,
          permissions: {
            modes: [
              { id: "manual_approval", label: "Manual" },
              { id: "full_access", label: "Full", dangerous: true },
            ],
            defaultModeId: "manual_approval",
          },
        };
      const full = permissionModeRef("full_access");
      expect(
        await deriveSession(test.client, catalog, {
          kind: "rollbackLastTurn",
          sourceRef,
          cwd: "/workspace",
          permissionModeId: full,
        }),
      ).toMatchObject({ permissionModeId: full });
      test.call.mockClear();
      await expect(
        deriveSession(test.client, catalog, {
          kind: "rollbackLastTurn",
          sourceRef,
          cwd: "/workspace",
          permissionModeId: permissionModeRef("missing"),
        }),
      ).rejects.toMatchObject({ code: "invalidRequest" });
      expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
    },
  );
  it.each([1, 2])(
    "preserves native Thinking across a %s-Turn rollback and rejects foreign choices before writes",
    async (count) => {
      const test = setup(count);
      const model = {
        id: "configured",
        label: "Configured",
        provider: "native",
        multimodal: false,
        thinking: { field: "reasoning_effort_level" as const, options: ["light", "high"] },
      };
      const catalog: BridgeInspection = {
        ...inspection,
        configuration: { modelSelection: "per-request", thinkingSelection: "per-request" },
        models: [model],
      };
      for (const item of test.source.items)
        if (item.role === "assistant" && item.model)
          Object.assign(item.model, { reasoning_effort_level: "high" });
      const high = thinkingOptionId("builder_v3", model, "high");
      expect(
        await deriveSession(test.client, catalog, {
          kind: "rollbackLastTurn",
          sourceRef,
          cwd: "/workspace",
        }),
      ).toMatchObject({ thinkingOptionId: high });
      test.call.mockClear();
      await expect(
        deriveSession(test.client, catalog, {
          kind: "rollbackLastTurn",
          sourceRef,
          cwd: "/workspace",
          thinkingOptionId: thinkingOptionId("builder_v3", { ...model, id: "other" }, "high"),
        }),
      ).rejects.toMatchObject({ code: "invalidRequest" });
      expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
    },
  );
  it.each([0, 1])(
    "copies exactly the native prefix through boundary %s without changing its source",
    async (index) => {
      const test = setup();
      const result = await deriveSession(test.client, inspection, {
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint(`a${index}`),
        cwd: "/workspace",
      });
      expect(result.nativeRef.nativeSessionId).toBe("derived");
      expect(result.model).toEqual(modelRef("builder_v3", "configured"));
      expect(test.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
        ["fork", { sessionId: "source", messageId: `a${index}` }],
      ]);
    },
  );
  it.each([1, 2])("rolls back a %s-Turn source by deriving a separate Session", async (count) => {
    const test = setup(count);
    await expect(
      deriveSession(test.client, inspection, {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ nativeRef: { nativeSessionId: "derived" } });
    const writes = test.call.mock.calls.filter(([method]) => method !== "snapshot");
    expect(writes).toEqual(
      count === 1
        ? [["create", { cwd: "/workspace", title: "CodexHost rollback" }]]
        : [["fork", { sessionId: "source", messageId: "a0" }]],
    );
  });
  it("rejects bad checkpoints, empty rollback, changed workspace and unsupported feature flags before writes", async () => {
    for (const input of [
      { kind: "fork" as const, sourceRef, checkpoint: checkpoint("missing"), cwd: "/workspace" },
      { kind: "fork" as const, sourceRef, checkpoint: checkpoint("a0"), cwd: "/different" },
    ]) {
      const test = setup();
      await expect(deriveSession(test.client, inspection, input)).rejects.toBeInstanceOf(Error);
      expect(test.call.mock.calls.some(([method]) => method !== "snapshot")).toBe(false);
    }
    const empty = setup(0);
    await expect(
      deriveSession(empty.client, inspection, {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: "/workspace",
      }),
    ).rejects.toMatchObject({ code: "invalidState" });
    const disabled = setup();
    await expect(
      deriveSession(
        disabled.client,
        { ...inspection, history: { forkFromMessage: false, forkFromSession: false } },
        { kind: "fork", sourceRef, checkpoint: checkpoint("a0"), cwd: "/workspace" },
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(disabled.call).not.toHaveBeenCalled();
  });
  it("rejects file-edit snapshot histories before the native fork write", async () => {
    const test = setup();
    Object.assign(test.source.items[1] ?? {}, { fileDiffs: [], fileDiffSourceIds: [] });
    await expect(
      deriveSession(test.client, inspection, {
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint("a0"),
        cwd: "/workspace",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
  });
  it("rejects busy or mismatched source Projects before any history write", async () => {
    for (const mutate of [
      (source: ReturnType<typeof setup>["source"]) => {
        source.status = 3;
      },
      (source: ReturnType<typeof setup>["source"]) => {
        source.projectId = "foreign";
      },
      (source: ReturnType<typeof setup>["source"]) => {
        source.workspaceFolders = ["/foreign"];
      },
    ]) {
      const test = setup();
      mutate(test.source);
      await expect(
        deriveSession(test.client, inspection, {
          kind: "rollbackLastTurn",
          sourceRef,
          cwd: "/workspace",
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(test.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
    }
  });
  it("preserves an explicit rollback model without relabeling historical Turns", async () => {
    const test = setup();
    const selected = modelRef("builder_v3", "other");
    const catalog = {
      ...inspection,
      models: [
        ...inspection.models,
        { id: "other", label: "Other", provider: "native", multimodal: false },
      ],
    };
    await expect(
      deriveSession(test.client, catalog, {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: "/workspace",
        model: selected,
      }),
    ).resolves.toMatchObject({ model: selected });
    expect(test.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
      ["fork", { sessionId: "source", messageId: "a0" }],
    ]);
    const unavailable = setup();
    await expect(
      deriveSession(unavailable.client, inspection, {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: "/workspace",
        model: selected,
      }),
    ).rejects.toMatchObject({ code: "configurationRequired" });
    expect(unavailable.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
  });
  it("can remove a sole file-edit Turn by creating an independent empty Session", async () => {
    const test = setup(1);
    Object.assign(test.source.items[1] ?? {}, { fileDiffs: [], fileDiffSourceIds: [] });
    await expect(
      deriveSession(test.client, inspection, {
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: "/workspace",
      }),
    ).resolves.toMatchObject({ nativeRef: { nativeSessionId: "derived" } });
    expect(test.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
      ["create", { cwd: "/workspace", title: "CodexHost rollback" }],
    ]);
  });
  it("preserves the exact derived identity on a prefix mismatch without repeating writes", async () => {
    const test = setup();
    const original = test.call.getMockImplementation();
    if (!original) throw new Error("Missing fixture");
    test.call.mockImplementation(async (method, input) => {
      const result = await original(method, input);
      return method === "snapshot" && input.sessionId === "derived"
        ? { ...result, items: [] }
        : result;
    });
    await expect(
      deriveSession(test.client, inspection, {
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint("a0"),
        cwd: "/workspace",
      }),
    ).rejects.toThrow("Derived Session derived was preserved");
    expect(test.call.mock.calls.filter(([method]) => method === "fork")).toHaveLength(1);
  });
});
