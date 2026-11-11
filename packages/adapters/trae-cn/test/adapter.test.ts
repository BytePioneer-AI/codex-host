import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { harnessInspectionSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { TraeCnAdapter } from "../src/adapter.js";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { modelRef, thinkingOptionId } from "../src/models.js";
import { permissionModeRef } from "../src/permissions.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup(configurable = false, thinking = false, permissions = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-adapter-"));
  const root = path.join(directory, "resources", "app");
  const cwd = path.join(directory, "workspace");
  await mkdir(root, { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(root, "product.json"), JSON.stringify({ applicationName: "trae-cn" }));
  const application = {
    name: "Trae CN",
    version: "fixture",
    root,
    executable: path.join(directory, "Trae CN.exe"),
  };
  const user = {
    chat_session_id: "native-session",
    message_id: "user",
    message_index: 1,
    role: "user",
    content: '[{"type":"text","text_content":"hello"}]',
  };
  let status = 5;
  let items: unknown[] = [
    user,
    {
      chat_session_id: "native-session",
      message_id: "assistant",
      message_index: 2,
      role: "assistant",
      reply_to_message_id: "user",
      status: "completed",
      model: {
        config_name: "configured",
        ...(thinking ? { reasoning_effort_level: "light" } : {}),
      },
      tokenUsage: { last_turn_total_tokens: 600, max_tokens: 1000 },
      content: '{"messages":[]}',
    },
  ];
  const snapshot = () => ({
    sessionId: "native-session",
    projectId: "project",
    workspaceFolders: [cwd],
    status,
    items,
  });
  const service = {
    application,
    workspaceFolders: [cwd],
    inspect: vi.fn(async () => ({
      application,
      workspaceFolders: [cwd],
      agentType: "builder_v3",
      ...(permissions
        ? {
            permissions: {
              modes: [
                { id: "manual_approval", label: "Manual" },
                { id: "full_access", label: "Full", dangerous: true },
              ],
              defaultModeId: "manual_approval",
            },
          }
        : {}),
      models: [
        {
          id: "configured",
          label: "Configured",
          provider: "native",
          multimodal: false,
          ...(thinking
            ? { thinking: { field: "reasoning_effort_level" as const, options: ["light", "high"] } }
            : {}),
        },
        ...(configurable
          ? [{ id: "alternative", label: "Alternative", provider: "native", multimodal: false }]
          : []),
      ],
      ...(configurable
        ? {
            configuration: {
              modelSelection: "per-request" as const,
              ...(thinking ? { thinkingSelection: "per-request" as const } : {}),
            },
          }
        : {}),
    })),
    call: vi.fn(async (method: string, input?: Record<string, unknown>) => {
      if (method === "preparePermission" && permissions)
        return { permissionModeId: input?.permissionModeId };
      if (method === "prepareModel" && configurable)
        return {
          agentType: "builder_v3",
          modelId: input?.modelId,
          ...(input?.thinking ? { thinking: input.thinking } : {}),
        };
      if (method !== "snapshot") throw new Error("Unexpected native write during open");
      return snapshot();
    }),
    subscribe: vi.fn(),
  };
  const server = await startServer(service, path.join(directory, "discovery"));
  const adapter = new TraeCnAdapter({
    cwd,
    environment: { CODEXHOST_TRAE_CN_BRIDGE_DIR: path.join(directory, "discovery") },
  });
  const reference = nativeSessionRefSchema.parse({
    harnessId: "trae-cn",
    nativeSessionId: "native-session",
    formatVersion: 1,
    locator: { applicationRoot: root, cwd, projectId: "project", agentType: "builder_v3" },
  });
  return {
    adapter,
    service,
    reference,
    cwd,
    snapshot,
    pending(active = false) {
      items = [user];
      if (active) status = 3;
    },
    activeWithoutHistory() {
      items = [];
      status = 3;
    },
    async close() {
      await adapter.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("TRAE CN public Adapter core", () => {
  it("requires the original native Agent before reading or writing a saved Session", async () => {
    const test = await setup();
    try {
      const reference = nativeSessionRefSchema.parse({
        ...test.reference,
        locator: {
          applicationRoot: test.service.application.root,
          cwd: test.cwd,
          projectId: "project",
          agentType: "solo_agent",
        },
      });
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: reference }),
      ).toMatchObject({
        ok: false,
        error: { code: "configurationRequired", message: expect.stringContaining("solo_agent") },
      });
      expect(test.service.call).not.toHaveBeenCalled();
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });
  it("defers cold restoration of a running background command and restores its terminal history without writes", async () => {
    const test = await setup();
    try {
      const plan = {
        id: "background",
        reply_to_message_id: "user",
        tool_call_info: {
          name: "RunCommand",
          params: { command: "echo OK", cwd: test.cwd, blocking: false },
          result: { status: "success", data: { command_id: "command" } },
        },
      };
      const status = {
        messageId: "user",
        planItemId: "background",
        commandId: "command",
        status: "running",
        output: "",
        outputTruncated: false,
      };
      const raw = {
        sessionId: "native-session",
        projectId: "project",
        workspaceFolders: [test.cwd],
        status: 5,
        items: [
          {
            chat_session_id: "native-session",
            message_id: "user",
            message_index: 1,
            role: "user",
            content: JSON.stringify([{ type: "text", text_content: "background" }]),
          },
          {
            chat_session_id: "native-session",
            message_id: "assistant",
            reply_to_message_id: "user",
            message_index: 2,
            role: "assistant",
            status: "completed",
            model: { config_name: "configured" },
            content: JSON.stringify({ messages: [{ type: "plan_item", plan_item: plan }] }),
            commandStatuses: [status],
          },
        ],
      };
      test.service.call.mockResolvedValue(raw);
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy", retryable: true } });
      const completed = structuredClone(raw);
      Object.assign(completed.items[1]?.commandStatuses?.[0] ?? {}, {
        status: "succeeded",
        output: "OK",
        exitCode: 0,
      });
      test.service.call.mockResolvedValue(completed);
      const opened = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(await opened.value.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          turns: [
            {
              items: [
                {
                  item: { type: "commandExecution", output: "OK", exitCode: 0 },
                  outcome: { status: "succeeded" },
                },
              ],
            },
          ],
        },
      });
      expect(test.service.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      expect(test.service.subscribe).not.toHaveBeenCalled();
      await opened.value.close();
    } finally {
      await test.close();
    }
  });
  it("restores an explicitly empty Thinking list for a model without native choices", async () => {
    const test = await setup(true, true);
    try {
      const opened = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
        model: modelRef("builder_v3", "alternative"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.availableThinkingOptions).toEqual([]);
      expect(opened.value.initialState.effectiveThinkingOptionId).toBeUndefined();
      expect(await opened.value.readSnapshot()).toMatchObject({
        ok: true,
        value: { state: { availableThinkingOptions: [] } },
      });
    } finally {
      await test.close();
    }
  });
  it("restores an explicit permission choice without inferring an old choice from native history", async () => {
    const test = await setup(true, false, true);
    try {
      const inspection = harnessInspectionSchema.parse(await test.adapter.inspect());
      expect(inspection).toMatchObject({
        status: "ready",
        capabilities: { configuration: { selectPermissionMode: true } },
        permissionModes: {
          defaultModeId: permissionModeRef("manual_approval"),
          modes: [
            { localizations: { "zh-CN": { label: "手动审批" } } },
            { localizations: { "zh-CN": { label: "完全访问" } } },
          ],
        },
      });
      const opened = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
        permissionModeId: permissionModeRef("full_access"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.effectivePermissionModeId).toBe(
        permissionModeRef("full_access"),
      );
      expect(test.service.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
        ["preparePermission", { sessionId: "native-session", permissionModeId: "full_access" }],
      ]);
      await opened.value.close();
      const nativeOnly = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      if (!nativeOnly.ok) throw new Error(nativeOnly.error.message);
      expect(nativeOnly.value.initialState.effectivePermissionModeId).toBeUndefined();
    } finally {
      await test.close();
    }
  });
  it("restores native Thinking read-only, or prepares an explicit next-request override", async () => {
    const test = await setup(true, true);
    try {
      const model = (await test.service.inspect()).models[0];
      if (!model) throw new Error("Missing fixture model");
      const light = thinkingOptionId("builder_v3", model, "light"),
        high = thinkingOptionId("builder_v3", model, "high");
      const restored = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      if (!restored.ok) throw new Error(restored.error.message);
      expect(restored.value.initialState.effectiveThinkingOptionId).toBe(light);
      expect(test.service.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      await restored.value.close();
      const overridden = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
        thinkingOptionId: high,
      });
      if (!overridden.ok) throw new Error(overridden.error.message);
      expect(overridden.value.initialState.effectiveThinkingOptionId).toBe(high);
      expect(test.service.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
        [
          "prepareModel",
          {
            sessionId: "native-session",
            modelId: "configured",
            thinking: { field: "reasoning_effort_level", level: "high" },
          },
        ],
      ]);
      expect(await test.service.call("snapshot")).toMatchObject({
        items: [{}, { model: { reasoning_effort_level: "light" } }],
      });
      expect(
        await test.adapter.open({ kind: "create", cwd: test.cwd, thinkingOptionId: high }),
      ).toMatchObject({ ok: false, error: { code: "configurationRequired" } });
    } finally {
      await test.close();
    }
  });
  it("restores a saved next-request selection without relabeling the original native Turn", async () => {
    const test = await setup(true);
    try {
      const model = modelRef("builder_v3", "alternative");
      const opened = await test.adapter.open({
        kind: "resume",
        nativeRef: test.reference,
        cwd: test.cwd,
        model,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialState.effectiveModel).toEqual(model);
      expect(await opened.value.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          state: { effectiveModel: model },
          turns: [{ model: modelRef("builder_v3", "configured") }],
        },
      });
      expect(test.service.call.mock.calls.filter(([method]) => method !== "snapshot")).toEqual([
        ["prepareModel", { modelId: "alternative", sessionId: "native-session" }],
      ]);
    } finally {
      await test.close();
    }
  });
  it("does not create a live Session after the Adapter closes during configuration restoration", async () => {
    const test = await setup(true);
    let release: ((value: Awaited<ReturnType<typeof test.service.call>>) => void) | undefined;
    try {
      const original = test.service.call.getMockImplementation();
      if (!original) throw new Error("Missing fixture");
      test.service.call.mockImplementation((method, input) =>
        method === "prepareModel"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : original(method, input),
      );
      const opened = test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
        model: modelRef("builder_v3", "alternative"),
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await test.adapter.close();
      release?.({ agentType: "builder_v3", modelId: "alternative" });
      expect(await opened).toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      release?.({ agentType: "builder_v3", modelId: "alternative" });
      await test.close();
    }
  });
  it("restores only native context occupancy as initial Session usage", async () => {
    const test = await setup();
    try {
      const opened = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.initialUsage).toEqual({
        contextUsedTokens: 600,
        contextWindowTokens: 1000,
        contextUsagePercent: 60,
      });
      expect(test.service.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
    } finally {
      await test.close();
    }
  });
  it.each([3, 8, 10])(
    "observes native status %s as a new autonomous Turn without resending",
    async (status) => {
      const test = await setup();
      try {
        const terminal = test.snapshot();
        test.service.call.mockResolvedValue({ ...terminal, status, items: [terminal.items[0]] });
        let listener: { data(value: unknown): void; end(): void } | undefined;
        test.service.subscribe.mockImplementation(async (_input, observer) => {
          listener = observer;
          return () => undefined;
        });
        const opened = await test.adapter.open({
          kind: "resume",
          cwd: test.cwd,
          nativeRef: test.reference,
        });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        expect(session.capabilities.autonomousTurns?.observe).toBe(true);
        // Native work may finish while Host is aligning the initial history.
        // Observation must not start until Host consumes outputs.
        expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(test.service.subscribe).not.toHaveBeenCalled();
        const iterator = session.outputs[Symbol.asyncIterator]();
        const started = await iterator.next();
        expect(started.value).toMatchObject({
          kind: "event",
          event: { type: "turn.autonomous.started", input: [{ type: "text", text: "hello" }] },
        });
        if (
          started.value?.kind !== "event" ||
          started.value.event.type !== "turn.autonomous.started"
        )
          throw new Error("Missing autonomous Turn");
        const turnId = started.value.event.turnId;
        expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
        await vi.waitFor(() => expect(listener).toBeDefined());
        expect(await session.readSnapshot()).toMatchObject({ ok: true, value: { turns: [] } });
        test.service.call.mockResolvedValue(terminal);
        listener?.data({
          event: "plan_item",
          payload: {
            id: "answer",
            tool_call_info: {
              name: "finish",
              params: { summary: "OK" },
              result: { status: "success" },
            },
          },
        });
        listener?.data({ event: "done", payload: {} });
        listener?.end();
        const outputs: HarnessOutput[] = [started.value];
        while (true) {
          const next = await iterator.next();
          if (next.done) throw new Error("Missing completion");
          outputs.push(next.value);
          if (next.value.kind === "event" && next.value.event.type === "turn.completed") break;
        }
        expect(outputs[1]).toMatchObject({ event: { type: "turn.started", turnId } });
        expect(outputs).toContainEqual(
          expect.objectContaining({
            event: expect.objectContaining({
              type: "item.started",
              turnId,
              item: expect.objectContaining({ type: "agentMessage", text: "OK" }),
            }),
          }),
        );
        expect(outputs.at(-1)).toMatchObject({
          event: {
            type: "turn.completed",
            turnId,
            nativeTurnRef: { nativeTurnKey: "user" },
            outcome: { status: "succeeded" },
          },
        });
        expect(
          outputs.filter(
            (output) => output.kind === "event" && output.event.type === "turn.autonomous.started",
          ),
        ).toHaveLength(1);
        expect(await session.readSnapshot()).toMatchObject({
          ok: true,
          value: {
            turns: [{ nativeTurnRef: { nativeTurnKey: "user" }, outcome: { status: "succeeded" } }],
          },
        });
        expect(test.service.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      } finally {
        await test.close();
      }
    },
  );
  it.each(["status-2", "status-9", "idle-pending", "multiple-pending", "not-last"])(
    "refuses unsafe native recovery: %s",
    async (kind) => {
      const test = await setup();
      try {
        const terminal = test.snapshot();
        const user = terminal.items[0] as Record<string, unknown>;
        const second = { ...user, message_id: "second", message_index: 3 };
        const items =
          kind === "not-last"
            ? [
                user,
                second,
                {
                  ...(terminal.items[1] as Record<string, unknown>),
                  message_id: "second-answer",
                  message_index: 4,
                  reply_to_message_id: "second",
                },
              ]
            : kind === "multiple-pending"
              ? [user, second]
              : [user];
        const status =
          kind === "status-2" ? 2 : kind === "status-9" ? 9 : kind === "idle-pending" ? 5 : 3;
        test.service.call.mockResolvedValue({ ...terminal, status, items });
        expect(
          await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
        ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
        expect(test.service.subscribe).not.toHaveBeenCalled();
        expect(test.service.call.mock.calls.every(([method]) => method === "snapshot")).toBe(true);
      } finally {
        await test.close();
      }
    },
  );
  it("reads the current scoped native model catalog without creating Sessions", async () => {
    const test = await setup();
    try {
      const first = harnessInspectionSchema.parse(await test.adapter.inspect());
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error("Fixture is not ready");
      expect(first.catalog.defaultModel).toBeUndefined();
      expect(first.catalog.models[0]?.ref).toEqual(modelRef("builder_v3", "configured"));
      expect(await test.adapter.inspect()).toEqual(first);
      expect(test.service.inspect).toHaveBeenCalledTimes(2);
      await test.adapter.inspect({ refresh: true });
      expect(test.service.inspect).toHaveBeenCalledTimes(4);
      expect(test.service.call).not.toHaveBeenCalled();
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("follows native Agent changes and does not mask lost authentication with an old catalog", async () => {
    const test = await setup();
    try {
      const initial = await test.service.inspect();
      const configured = initial.models[0];
      if (!configured) throw new Error("Fixture model is missing");
      expect(await test.adapter.inspect()).toMatchObject({ status: "ready" });
      test.service.inspect.mockResolvedValue({
        ...initial,
        agentType: "solo_agent",
        models: [{ ...configured, id: "solo-choice", label: "SOLO choice" }],
      });
      expect(await test.adapter.inspect()).toMatchObject({
        status: "ready",
        catalog: { models: [{ ref: modelRef("solo_agent", "solo-choice"), label: "SOLO choice" }] },
      });
      test.service.inspect.mockRejectedValueOnce(
        Object.assign(new Error("Sign in again"), { code: "authenticationRequired" }),
      );
      expect(await test.adapter.inspect()).toMatchObject({
        status: "unavailable",
        error: { code: "authenticationRequired" },
      });
      expect(test.service.call).not.toHaveBeenCalled();
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      await test.close();
    }
  });

  it("opens create lazily and resumes the exact native history read-only", async () => {
    const test = await setup();
    try {
      const created = await test.adapter.open({
        kind: "create",
        cwd: test.cwd,
        model: modelRef("builder_v3", "configured"),
      });
      expect(created.ok).toBe(true);
      expect(test.service.call).not.toHaveBeenCalled();
      if (created.ok) await created.value.close();
      const resumed = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
      });
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect(resumed.value.initialState).toEqual({
        nativeRef: test.reference,
        effectiveModel: modelRef("builder_v3", "configured"),
      });
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: true,
        value: {
          turns: [{ nativeTurnRef: { nativeTurnKey: "user" }, outcome: { status: "succeeded" } }],
        },
      });
      expect(test.service.call.mock.calls.every((args) => args[0] === "snapshot")).toBe(true);
      await test.adapter.close();
      expect(await resumed.value.readSnapshot()).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
    } finally {
      await test.close();
    }
  });

  it("rejects foreign identities, pending history and unverified unattended permissions", async () => {
    const test = await setup();
    try {
      const foreign = nativeSessionRefSchema.parse({ ...test.reference, harnessId: "other" });
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: foreign }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      expect(test.service.call).not.toHaveBeenCalled();
      test.pending();
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
      const before = test.service.inspect.mock.calls.length;
      expect(
        await test.adapter.open({
          kind: "create",
          cwd: test.cwd,
          executionPolicy: "unattended-full-access",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(test.service.inspect).toHaveBeenCalledTimes(before);
    } finally {
      await test.close();
    }
  });

  it("does not mistake an active task with uncommitted history for an empty idle Session", async () => {
    const test = await setup();
    try {
      test.activeWithoutHistory();
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
      ).toMatchObject({ ok: false, error: { code: "sessionBusy" } });
    } finally {
      await test.close();
    }
  });
});
