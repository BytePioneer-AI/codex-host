import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { harnessInspectionSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { TraeCnAdapter } from "../src/adapter.js";
import { hostTurnIdSchema, nativeTurnRefSchema } from "@codexhost/shared-contracts";
import { modelRef, thinkingOptionId } from "../src/models.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup(configurable = false, thinking = false) {
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
  const service = {
    application,
    workspaceFolders: [cwd],
    inspect: vi.fn(async () => ({
      application,
      workspaceFolders: [cwd],
      agentType: "builder_v3",
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
      if (method === "prepareModel" && configurable)
        return {
          agentType: "builder_v3",
          modelId: input?.modelId,
          ...(input?.thinking ? { thinking: input.thinking } : {}),
        };
      if (method !== "snapshot") throw new Error("Unexpected native write during open");
      return {
        sessionId: "native-session",
        projectId: "project",
        workspaceFolders: [cwd],
        status,
        items,
      };
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
      const before = await test.service.call("snapshot");
      expect(before.items).toMatchObject([{}, { model: { reasoning_effort_level: "light" } }]);
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
  it("reattaches only an active native task with its confirmed original Host identity", async () => {
    const test = await setup();
    try {
      test.pending(true);
      const nativeTurnRef = nativeTurnRefSchema.parse({
        harnessId: "trae-cn",
        nativeSessionId: "native-session",
        nativeTurnKey: "user",
        formatVersion: 1,
      });
      expect(
        await test.adapter.open({ kind: "resume", cwd: test.cwd, nativeRef: test.reference }),
      ).toMatchObject({ ok: false, error: { code: "configurationRequired" } });
      test.service.subscribe.mockImplementation(async () => () => undefined);
      const turnId = hostTurnIdSchema.parse("original-host-turn");
      const opened = await test.adapter.open({
        kind: "resume",
        cwd: test.cwd,
        nativeRef: test.reference,
        knownTurns: [{ turnId, nativeTurnRef }],
      });
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.recoveringTurn).toMatchObject({
        turnId,
        nativeTurnRef,
        input: [{ type: "text", text: "hello" }],
      });
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot).toMatchObject({
        ok: true,
        value: { turns: [{ nativeTurnRef, outcome: { status: "unknown" } }] },
      });
      await vi.waitFor(() => expect(test.service.subscribe).toHaveBeenCalledOnce());
      expect(test.service.call.mock.calls.every((args) => args[0] === "snapshot")).toBe(true);
      await opened.value.close();
      const outputs = [];
      for await (const output of opened.value.outputs) outputs.push(output);
      expect(outputs[0]).toMatchObject({ event: { type: "turn.started", turnId } });
      expect(outputs.at(-1)).toMatchObject({
        event: { type: "turn.completed", turnId, nativeTurnRef, outcome: { status: "failed" } },
      });
    } finally {
      await test.close();
    }
  });
  it("caches the observed native model catalog in its scope without creating Sessions", async () => {
    const test = await setup();
    try {
      const first = harnessInspectionSchema.parse(await test.adapter.inspect());
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error("Fixture is not ready");
      expect(first.catalog.defaultModel).toBeUndefined();
      expect(first.catalog.models[0]?.ref).toEqual(modelRef("builder_v3", "configured"));
      expect(await test.adapter.inspect()).toEqual(first);
      expect(test.service.inspect).toHaveBeenCalledOnce();
      await test.adapter.inspect({ refresh: true });
      expect(test.service.inspect).toHaveBeenCalledTimes(3);
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
