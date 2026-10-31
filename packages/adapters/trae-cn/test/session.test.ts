import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
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

async function setup(selected = true, deferred = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-session-"));
  let messageId = "",
    listener: Listener | undefined;
  let status = "in_progress";
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
        return { accepted: true, messageId, fromAppend: false };
      }
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
    inspect: vi.fn(),
    call,
    subscribe: vi.fn(async (_input: unknown, observer: Listener) => {
      listener = observer;
      observer.data({
        event: "metadata",
        payload: { reply_to_message_id: messageId, model: { config_name: "configured" } },
      });
      if (!deferred) finish("completed");
      return detach;
    }),
  };
  const server: { endpoint: Endpoint; close(): Promise<void> } = await startServer(
    service,
    directory,
  );
  const session = new TraeCnSession({
    client: new BridgeClient(server.endpoint),
    inspection,
    cwd: "/workspace",
    ...(selected ? { model: modelRef("builder_v3", "configured") } : {}),
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

  it("closes only its own observers without issuing native stop or fabricated completion", async () => {
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
        outputs.some((value) => value.kind === "event" && value.event.type === "turn.completed"),
      ).toBe(false);
      expect(test.call.mock.calls.some((args) => args[0] === "cancel")).toBe(false);
      expect(await test.session.execute(command())).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await test.close();
    }
  });
});
