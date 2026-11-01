import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  hostTurnIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
} from "@codexhost/shared-contracts";
import { BridgeClient } from "../src/bridge.js";
import type { BridgeInspection, Endpoint } from "../src/protocol.js";
import { TraeCnSession } from "../src/session.js";
import { modelRef } from "../src/models.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");
type Listener = { data(value: unknown): void; end(): void; error(error: unknown): void };
const application = { name: "Trae CN", version: "fixture", root: "/app", executable: "/app/trae" };
const inspection: BridgeInspection = {
  application,
  instanceId: "instance",
  workspaceFolders: ["/workspace"],
  agentType: "builder_v3",
  models: [{ id: "configured", label: "Configured", provider: "native", multimodal: false }],
};

async function setup(
  selected = true,
  deferred = false,
  history = false,
  configurable = false,
  recovering = false,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-session-"));
  let messageId = recovering ? "recovering-user" : "",
    listener: Listener | undefined;
  let status = "in_progress";
  let nativeModel = "configured";
  const sessionInspection: BridgeInspection = {
    ...inspection,
    ...(history ? { history: { forkFromMessage: true, forkFromSession: true } } : {}),
    ...(configurable
      ? {
          configuration: { modelSelection: "per-request" },
          models: [
            ...inspection.models,
            { id: "alternative", label: "Alternative", provider: "native", multimodal: false },
          ],
        }
      : {}),
  };
  let messages: unknown[] = [];
  const content = {
    task_id: "task",
    messages: [
      {
        type: "plan_item",
        plan_item: {
          id: "plan",
          tool_call_info: {
            name: "finish",
            params: { summary: "OK" },
            result: { status: "success" },
          },
          timing: { tool_call_finished_at_ms: 2 },
        },
      },
    ],
  };
  const finish = (nextStatus: string) => {
    status = nextStatus;
    messages = [
      {
        chat_session_id: "native-session",
        message_id: messageId,
        message_index: 1,
        role: "user",
        content: '[{"type":"text","text_content":"hello"}]',
      },
      {
        chat_session_id: "native-session",
        message_id: "native-assistant",
        reply_to_message_id: messageId,
        message_index: 2,
        role: "assistant",
        status,
        model: { config_name: nativeModel },
        content: JSON.stringify(content),
      },
    ];
    if (nextStatus === "completed")
      listener?.data({
        event: "plan_item",
        payload: { ...content.messages[0]?.plan_item, reply_to_message_id: messageId },
      });
    listener?.data({ event: "done", payload: { status, reply_to_message_id: messageId } });
    listener?.end();
  };
  const call = vi.fn<(method: string, input: Record<string, unknown>) => Promise<unknown>>(
    async (method, input) => {
      if (method === "create") return { sessionId: "native-session", projectId: "project" };
      if (method === "start") {
        messageId = String(input.messageId);
        nativeModel = String(input.modelId);
        return { accepted: true, messageId, fromAppend: false };
      }
      if (method === "prepareModel") return { agentType: "builder_v3", modelId: input.modelId };
      if (method === "snapshot")
        return { sessionId: "native-session", projectId: "project", items: messages };
      if (method === "cancel") {
        finish("canceled");
        return undefined;
      }
      throw new Error("Unsupported fixture method");
    },
  );
  const detach = vi.fn();
  const service = {
    application,
    workspaceFolders: ["/workspace"],
    inspect: vi.fn(async () => sessionInspection),
    call,
    subscribe: vi.fn(async (_input: unknown, observer: Listener) => {
      listener = observer;
      observer.data({
        event: "metadata",
        payload: { reply_to_message_id: messageId, model: { config_name: nativeModel } },
      });
      if (!deferred) finish("completed");
      return detach;
    }),
  };
  const server: { endpoint: Endpoint; close(): Promise<void> } = await startServer(
    service,
    directory,
  );
  sessionInspection.instanceId = server.endpoint.instanceId;
  const reference = nativeSessionRefSchema.parse({
    harnessId: "trae-cn",
    nativeSessionId: "native-session",
    formatVersion: 1,
    locator: {
      applicationRoot: "/app",
      cwd: "/workspace",
      projectId: "project",
      agentType: "builder_v3",
    },
  });
  const recovery = {
    turnId: hostTurnIdSchema.parse("recovering-host"),
    nativeTurnRef: nativeTurnRefSchema.parse({
      harnessId: "trae-cn",
      nativeSessionId: "native-session",
      nativeTurnKey: "recovering-user",
      formatVersion: 1,
    }),
    input: [{ type: "text" as const, text: "hello" }],
  };
  const session = new TraeCnSession({
    client: new BridgeClient(server.endpoint),
    inspection: sessionInspection,
    cwd: "/workspace",
    ...(selected ? { model: modelRef("builder_v3", "configured") } : {}),
    ...(recovering
      ? {
          nativeRef: reference,
          recoveringTurn: recovery,
          recoverySnapshot: {
            turns: [
              {
                nativeTurnRef: recovery.nativeTurnRef,
                input: recovery.input,
                items: [],
                outcome: { status: "unknown", reason: "Native pending task" },
              },
            ],
          },
        }
      : {}),
  });
  const iterator = session.outputs[Symbol.asyncIterator]();
  return {
    session,
    call,
    service,
    iterator,
    finish,
    detach,
    async close() {
      await session.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function completed(iterator: AsyncIterator<HarnessOutput>): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error("Session ended before Turn completion");
    outputs.push(next.value);
    if (next.value.kind === "event" && next.value.event.type === "turn.completed") return outputs;
  }
}
const command = (id = "host-turn") => ({
  type: "turn.start" as const,
  turnId: hostTurnIdSchema.parse(id),
  input: [{ type: "text" as const, text: "hello" }],
});

describe("TRAE CN public Session core", () => {
  it("uses the native-confirmed model after recovery when pending history had no model yet", async () => {
    const test = await setup(false, false, false, true, true);
    try {
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { turnId: "recovering-host", outcome: { status: "succeeded" } },
      });
      expect(await test.session.execute(command("continued"))).toMatchObject({ ok: true });
      await completed(test.iterator);
      expect(test.call.mock.calls.filter(([method]) => method === "start")).toHaveLength(1);
      expect(test.call.mock.calls.find(([method]) => method === "start")?.[1].modelId).toBe(
        "configured",
      );
      expect(test.call.mock.calls.some(([method]) => method === "create")).toBe(false);
    } finally {
      await test.close();
    }
  });
  it("prepares a manual model choice without creating a Session, then sends that exact native DTO", async () => {
    const test = await setup(false, false, false, true);
    try {
      expect(test.session.capabilities.configuration.selectModel).toBe(true);
      const model = modelRef("builder_v3", "alternative");
      expect(await test.session.execute({ type: "model.select", model })).toEqual({
        ok: true,
        value: { completed: true },
      });
      expect(await test.session.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [], state: { effectiveModel: model } },
      });
      expect(test.call.mock.calls.map(([method]) => method)).toEqual(["prepareModel"]);
      await test.session.execute(command());
      await completed(test.iterator);
      expect(test.call.mock.calls.find(([method]) => method === "start")?.[1].modelId).toBe(
        "alternative",
      );
      expect(await test.session.readSnapshot()).toMatchObject({
        ok: true,
        value: { turns: [{ model }] },
      });
    } finally {
      await test.close();
    }
  });
  it("keeps an active Turn's model while switching the next request and ignores its stale model events", async () => {
    const test = await setup(true, true, false, true);
    try {
      await test.session.execute(command());
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      const selected = modelRef("builder_v3", "alternative");
      expect(await test.session.execute({ type: "model.select", model: selected })).toMatchObject({
        ok: true,
      });
      const observer = test.service.subscribe.mock.calls[0]?.[1];
      observer?.data({ event: "model_config", payload: { config_name: "configured" } });
      test.finish("completed");
      const outputs = await completed(test.iterator);
      const states = outputs
        .filter((o) => o.kind === "event" && o.event.type === "session.state.changed")
        .map((o) =>
          o.kind === "event" && o.event.type === "session.state.changed"
            ? o.event.state.effectiveModel
            : undefined,
        )
        .filter(Boolean);
      expect(states.at(-1)).toEqual(selected);
      expect(await test.session.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          state: { effectiveModel: selected },
          turns: [{ model: modelRef("builder_v3", "configured") }],
        },
      });
      await test.session.execute(command("next"));
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledTimes(2));
      test.finish("completed");
      await completed(test.iterator);
      expect(
        test.call.mock.calls
          .filter(([method]) => method === "start")
          .map(([, input]) => input.modelId),
      ).toEqual(["configured", "alternative"]);
    } finally {
      await test.close();
    }
  });
  it("leaves the prior selection intact when native preparation fails or returns a different model", async () => {
    const test = await setup(true, false, false, true);
    try {
      const original = test.call.getMockImplementation();
      if (!original) throw new Error("Missing fixture");
      test.call.mockImplementation(async (method, input) =>
        method === "prepareModel"
          ? { agentType: "builder_v3", modelId: "different" }
          : original(method, input),
      );
      expect(
        await test.session.execute({
          type: "model.select",
          model: modelRef("builder_v3", "alternative"),
        }),
      ).toMatchObject({ ok: false, error: { code: "protocolError" } });
      expect(test.call.mock.calls.filter(([method]) => method === "prepareModel")).toHaveLength(1);
      expect(await test.session.readSnapshot()).toMatchObject({ ok: true, value: { state: {} } });
      await test.session.execute(command());
      await completed(test.iterator);
      expect(test.call.mock.calls.find(([method]) => method === "start")?.[1].modelId).toBe(
        "configured",
      );
    } finally {
      await test.close();
    }
    const old = await setup();
    try {
      expect(
        await old.session.execute({
          type: "model.select",
          model: modelRef("builder_v3", "configured"),
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(old.call).not.toHaveBeenCalled();
    } finally {
      await old.close();
    }
  });
  it("serializes configuration against admission and cannot publish a late selection after close", async () => {
    const test = await setup(true, false, false, true);
    let release: ((value: unknown) => void) | undefined;
    try {
      const original = test.call.getMockImplementation();
      if (!original) throw new Error("Missing fixture");
      test.call.mockImplementation((method, input) =>
        method === "prepareModel"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : original(method, input),
      );
      const selecting = test.session.execute({
        type: "model.select",
        model: modelRef("builder_v3", "alternative"),
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(await test.session.execute(command())).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(
        await test.session.execute({
          type: "model.select",
          model: modelRef("builder_v3", "configured"),
        }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      await test.session.close();
      release?.({ agentType: "builder_v3", modelId: "alternative" });
      expect(await selecting).toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(await test.iterator.next()).toEqual({ done: true, value: undefined });
      expect(test.call.mock.calls.every(([method]) => method === "prepareModel")).toBe(true);
    } finally {
      release?.({ agentType: "builder_v3", modelId: "alternative" });
      await test.close();
    }
  });
  it("disables file-edit forks while retaining a rollback to an empty Session", async () => {
    const test = await setup(true, true, true);
    try {
      expect(test.session.capabilities.history).toMatchObject({
        fork: true,
        rollbackLastTurn: true,
      });
      await test.session.execute(command());
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      const observer = test.service.subscribe.mock.calls[0]?.[1];
      if (!observer) throw new Error("Missing observer");
      observer.data({
        event: "plan_item",
        payload: {
          id: "edit",
          timing: { tool_call_started_at_ms: 1, tool_call_finished_at_ms: 2 },
          tool_call_info: {
            name: "Edit",
            params: { file_path: "/workspace/file" },
            result: { status: "success", data: { can_show_diff: true } },
          },
        },
      });
      await vi.waitFor(() =>
        expect(test.session.capabilities.history).toMatchObject({
          fork: false,
          rollbackLastTurn: true,
        }),
      );
      test.finish("completed");
      await completed(test.iterator);
      expect(test.session.capabilities.history.fork).toBe(false);
    } finally {
      await test.close();
    }
  });
  it("publishes context occupancy for its active Turn and isolates usage refresh errors", async () => {
    const test = await setup(true, true);
    try {
      await test.session.execute(command());
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      const listener = test.service.subscribe.mock.calls[0]?.[1];
      if (!listener) throw new Error("Missing live observer");
      listener.data({
        event: "token_usage",
        payload: {
          last_turn_total_tokens: 250,
          max_tokens: 1000,
          prompt_tokens: 200,
          completion_tokens: 50,
          prompt_tokens_total: 0,
          completion_tokens_total: 0,
        },
      });
      const before = test.call.mock.calls.length;
      await test.session.refreshUsage();
      expect(test.call).toHaveBeenCalledTimes(before);
      test.finish("completed");
      const outputs = await completed(test.iterator);
      expect(
        outputs.filter((o) => o.kind === "event" && o.event.type === "session.usage.changed"),
      ).toMatchObject([
        {
          event: {
            type: "session.usage.changed",
            observedForTurnId: "host-turn",
            usage: { contextUsedTokens: 250, contextWindowTokens: 1000, contextUsagePercent: 25 },
          },
        },
      ]);
      const usage = outputs.find(
        (o) => o.kind === "event" && o.event.type === "session.usage.changed",
      );
      expect(JSON.stringify(usage)).not.toContain("inputTokens");
      test.call.mockRejectedValueOnce(new Error("usage temporarily unavailable"));
      await expect(test.session.refreshUsage()).resolves.toBeUndefined();
      expect(await test.session.execute(command("next"))).toMatchObject({ ok: true });
    } finally {
      await test.close();
    }
  });
  it("opens lazily and publishes only native-confirmed identity and configuration", async () => {
    const test = await setup();
    try {
      expect(test.session.initialState).toEqual({});
      expect(test.call).not.toHaveBeenCalled();
      expect(await test.session.readSnapshot()).toEqual({
        ok: true,
        value: { turns: [], state: {} },
      });
      expect(await test.session.execute(command())).toEqual({
        ok: true,
        value: { turnId: "host-turn" },
      });
      const outputs = await completed(test.iterator);
      expect(outputs[0]).toMatchObject({ event: { type: "turn.started", turnId: "host-turn" } });
      expect(outputs.at(-1)).toMatchObject({
        event: {
          type: "turn.completed",
          turnId: "host-turn",
          outcome: { status: "succeeded" },
          nativeTurnRef: { nativeSessionId: "native-session" },
        },
      });
      const snapshot = await test.session.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: {
          state: {
            nativeRef: { nativeSessionId: "native-session" },
            effectiveModel: modelRef("builder_v3", "configured"),
          },
          turns: [{ items: [{ item: { text: "OK", phase: "final_answer" } }] }],
        },
      });
      expect(test.call.mock.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("rejects empty input, a missing manual selection and a concurrent Turn before native writes", async () => {
    const empty = await setup(false);
    try {
      expect(await empty.session.execute(command())).toMatchObject({
        ok: false,
        error: { code: "configurationRequired" },
      });
      expect(await empty.session.execute({ ...command(), input: [] })).toMatchObject({
        ok: false,
        error: { code: "invalidRequest" },
      });
      expect(empty.call).not.toHaveBeenCalled();
    } finally {
      await empty.close();
    }
    const active = await setup(true, true);
    try {
      await active.session.execute(command());
      expect(await active.session.readSnapshot()).toMatchObject({
        ok: false,
        error: { code: "sessionBusy" },
      });
      expect(await active.session.execute(command("second"))).toMatchObject({
        ok: false,
        error: { code: "sessionBusy", retryable: true },
      });
    } finally {
      await active.close();
    }
  });

  it("waits for native cancellation and can subsequently execute another Turn", async () => {
    const test = await setup(true, true);
    try {
      await test.session.execute(command());
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      expect(
        await test.session.execute({
          type: "turn.cancel",
          turnId: hostTurnIdSchema.parse("other"),
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(await test.session.execute({ type: "turn.cancel", turnId: command().turnId })).toEqual(
        { ok: true, value: { cancellationRequested: true } },
      );
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { type: "turn.completed", outcome: { status: "cancelled" } },
      });
      expect(await test.session.execute(command("next"))).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledTimes(2));
      test.finish("completed");
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { turnId: "next", outcome: { status: "succeeded" } },
      });
      expect(test.call.mock.calls.filter((args) => args[0] === "create")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("does not retry an uncertain native admission or report it as native success", async () => {
    const test = await setup();
    const original = test.call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    test.call.mockImplementation(async (method, input) => {
      if (method === "start") throw new Error("Native receipt lost");
      return original(method, input);
    });
    try {
      expect(await test.session.execute(command())).toMatchObject({ ok: true });
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { outcome: { status: "failed" } },
      });
      expect(test.call.mock.calls.filter((args) => args[0] === "start")).toHaveLength(1);
      expect(await test.session.execute(command("retry"))).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await test.close();
    }
  });

  it("preserves a durable native identity when an admitted observer faults", async () => {
    const test = await setup();
    const original = test.call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    test.call.mockImplementation(async (method, input) => {
      if (method !== "snapshot") return original(method, input);
      const start = test.call.mock.calls.find((args) => args[0] === "start")?.[1];
      return {
        sessionId: "native-session",
        items: [
          {
            chat_session_id: "native-session",
            message_id: start?.messageId,
            message_index: 1,
            role: "user",
            content: '[{"type":"text","text_content":"hello"}]',
          },
        ],
      };
    });
    test.service.subscribe.mockImplementation(async (_input, listener) => {
      listener.error(new Error("Observation lost"));
      return test.detach;
    });
    try {
      await test.session.execute(command());
      const outputs = await completed(test.iterator);
      const terminal = outputs.at(-1);
      const start = test.call.mock.calls.find((args) => args[0] === "start")?.[1];
      expect(terminal).toMatchObject({
        event: {
          type: "turn.completed",
          nativeTurnRef: { nativeTurnKey: start?.messageId },
          outcome: { status: "failed" },
        },
      });
      expect(test.call.mock.calls.filter((args) => args[0] === "start")).toHaveLength(1);
    } finally {
      await test.close();
    }
  });

  it("uses a native failed terminal record without faulting an otherwise usable Session", async () => {
    const test = await setup();
    const original = test.service.subscribe.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    test.service.subscribe.mockImplementationOnce(async (_input, listener) => {
      listener.data({ event: "error", payload: { message: "Provider authentication failed" } });
      test.finish("failed");
      listener.data({ event: "done", payload: { status: "failed" } });
      listener.end();
      return test.detach;
    });
    try {
      await test.session.execute(command());
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: {
          outcome: { status: "failed" },
          nativeTurnRef: { nativeSessionId: "native-session" },
        },
      });
      expect(await test.session.execute(command("next"))).toMatchObject({ ok: true });
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { turnId: "next", outcome: { status: "succeeded" } },
      });
    } finally {
      await test.close();
    }
  });

  it("settles the observer scope on close without issuing native stop or claiming native success", async () => {
    const test = await setup(true, true);
    try {
      await test.session.execute(command());
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      await test.session.close();
      const outputs: HarnessOutput[] = [];
      while (true) {
        const next = await test.iterator.next();
        if (next.done) break;
        outputs.push(next.value);
      }
      expect(
        outputs.filter((value) => value.kind === "event" && value.event.type === "turn.completed"),
      ).toMatchObject([
        {
          event: {
            turnId: command().turnId,
            outcome: { status: "failed", error: { code: "unavailable" } },
          },
        },
      ]);
      expect(test.call.mock.calls.some((args) => args[0] === "cancel")).toBe(false);
      expect(await test.session.execute(command())).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await test.close();
    }
  });

  it("routes an explicit public question response to the owned native instance", async () => {
    const test = await setup(true, true);
    const subscribe = test.service.subscribe.getMockImplementation();
    const call = test.call.getMockImplementation();
    if (!subscribe || !call) throw new Error("Missing fixture implementation");
    test.service.subscribe.mockImplementation(async (input, listener) => {
      const detach = await subscribe(input, listener);
      const start = test.call.mock.calls.find((args) => args[0] === "start")?.[1];
      listener.data({
        event: "plan_item",
        payload: {
          id: "question-plan",
          reply_to_message_id: start?.messageId,
          confirm_info: {
            confirm_status: "unconfirmed",
            interaction_instance_id: "question-instance",
            auto_confirm: false,
          },
          tool_call_info: {
            name: "AskUserQuestion",
            params: {
              questions: [
                {
                  header: "测试",
                  question: "请选择",
                  options: [{ label: "继续" }, { label: "停止" }],
                  multiSelect: false,
                },
              ],
            },
          },
        },
      });
      return detach;
    });
    test.call.mockImplementation(async (method, input) => {
      if (method === "respond") {
        test.finish("completed");
        return { accepted: true };
      }
      return call(method, input);
    });
    try {
      await test.session.execute(command());
      let question;
      while (!question) {
        const next = await test.iterator.next();
        if (next.done) throw new Error("Missing question");
        if (next.value.kind === "interaction") question = next.value.interaction;
      }
      expect(question.type).toBe("question");
      expect(
        await test.session.execute({
          type: "interaction.respond",
          interactionId: question.interactionId,
          response: { type: "question", answers: { "question-0": ["停止"] } },
        }),
      ).toEqual({ ok: true, value: { accepted: true } });
      const outputs = await completed(test.iterator);
      expect(outputs).toContainEqual({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: question.interactionId,
          turnId: command().turnId,
          reason: "responded",
        },
      });
      expect(outputs.at(-1)).toMatchObject({
        event: { type: "turn.completed", outcome: { status: "succeeded" } },
      });
      const response = test.call.mock.calls.find((args) => args[0] === "respond")?.[1];
      expect(response).toMatchObject({
        sessionId: "native-session",
        planItemId: "question-plan",
        interactionId: "question-instance",
        answers: [["停止"]],
      });
      expect(response?.messageId).toBe(
        test.call.mock.calls.find((args) => args[0] === "start")?.[1].messageId,
      );
    } finally {
      await test.close();
    }
  });

  it("waits for native history visibility after stream completion without restarting the task", async () => {
    const test = await setup();
    const original = test.call.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    let reads = 0;
    test.call.mockImplementation(async (method, input) => {
      if (method === "snapshot" && ++reads === 1) return { sessionId: "native-session", items: [] };
      return original(method, input);
    });
    try {
      await test.session.execute(command());
      expect((await completed(test.iterator)).at(-1)).toMatchObject({
        event: { outcome: { status: "succeeded" } },
      });
      expect(reads).toBe(2);
      expect(test.call.mock.calls.filter((args) => args[0] === "start")).toHaveLength(1);
      expect(test.service.subscribe).toHaveBeenCalledOnce();
    } finally {
      await test.close();
    }
  });
});
