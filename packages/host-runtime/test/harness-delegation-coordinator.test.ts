import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { CodexTurnProjector, type ExternalHarnessId } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessModelCatalogSchema,
  hostThreadIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { startDelegationControlServer } from "../src/delegation-control-server.js";
import { externalClientMcp } from "../src/external-client-mcp.js";
import { externalClientRouter } from "../src/external-client-routes.js";
import { startExternalClientServer } from "../src/external-client-server.js";
import { ExternalClientRegistry } from "../src/external-clients.js";
import { HarnessDelegationCoordinator } from "../src/harness-delegation-coordinator.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime, type ExternalThread } from "../src/external-thread-runtime.js";

async function fixture(
  adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi")),
  officialThreadCwd: (
    threadId: string,
  ) => Promise<string | undefined | { cwd?: string; title?: string }> = async () => undefined,
  environment: NodeJS.ProcessEnv = {},
  externalThreadBusy: (thread: ExternalThread) => boolean = (thread) => thread.running,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-delegation-coordinator-"));
  const store = new MappingStore({ directory });
  await store.initialize();
  const repository = new ExternalThreadRepository(store);
  const adapters = new Map<ExternalHarnessId, HarnessAdapter>([
    [adapter.harnessId as ExternalHarnessId, adapter],
  ]);
  const registered: ReturnType<ExternalThreadRuntime["register"]>[] = [];
  const notifications: unknown[] = [];
  const treeChanged = vi.fn<(threadId: string) => void>();
  const delivered: string[] = [];
  const runtime = new ExternalThreadRuntime({
    adapters,
    environment,
    repository,
    consumeOutputs: async () => undefined,
    diagnose: () => undefined,
  });
  const coordinator = new HarnessDelegationCoordinator({
    adapters,
    environment,
    externalRuntime: runtime,
    repository,
    registerExternalThread: (input) => {
      const thread = runtime.register(input);
      registered.push(thread);
      return thread;
    },
    startExternalTurn: async (thread, text, turnId) => {
      delivered.push(text);
      thread.running = true;
      thread.activeTurnId = hostTurnIdSchema.parse(turnId);
      const result = await thread.session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse(turnId),
        input: [{ type: "text", text }],
      });
      if (!result.ok) throw new Error(result.error.message);
    },
    notifyThreadStarted: async (thread) => {
      notifications.push(thread);
    },
    notifyTreeChanged: treeChanged,
    inspectOfficial: vi.fn(),
    readOfficial: vi.fn(),
    sendOfficial: vi.fn(),
    cancelOfficial: vi.fn(),
    startOfficial: vi.fn(),
    listOfficial: vi.fn(async () => ({ threads: [], nextCursor: null })),
    officialThreadMetadata: async (threadId) => {
      const metadata = await officialThreadCwd(threadId);
      return typeof metadata === "string" ? { cwd: metadata } : (metadata ?? {});
    },
    activeOfficialParents: () => [],
    externalThreadBusy,
  });
  return {
    adapter,
    coordinator,
    directory,
    delivered,
    notifications,
    treeChanged,
    registered,
    repository,
    runtime,
    store,
    close: async () => {
      runtime.clear();
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

class RecordingAdapter extends FakeHarnessAdapter {
  readonly openInputs: Parameters<FakeHarnessAdapter["open"]>[0][] = [];

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    this.openInputs.push(input);
    return super.open(input);
  }
}

function nativeSelectionCatalog() {
  return harnessModelCatalogSchema.parse({
    models: [
      {
        ref: { id: "encoded-model" },
        nativeId: "provider/model-a",
        label: "Model A",
        supportedThinkingOptionIds: ["encoded-thinking"],
      },
    ],
    defaultModel: { id: "encoded-model" },
    thinkingOptions: [{ id: "encoded-thinking", nativeId: "reasoning=high", label: "High" }],
    defaultThinkingOptionId: "encoded-thinking",
  });
}

class FailingTurnAdapter extends FakeHarnessAdapter {
  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    const opened = await super.open(input);
    if (opened.ok) {
      const session = opened.value as FakeHarnessSession;
      session.rejectNextTurn({
        code: "nativeFailure",
        message: "synthetic initial delivery failure",
        retryable: false,
      });
    }
    return opened;
  }
}

describe("HarnessDelegationCoordinator", () => {
  it("invalidates the tree only after the external delegation record write completes", async () => {
    const value = await fixture();
    const written = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const create = value.repository.createDelegation.bind(value.repository);
    vi.spyOn(value.repository, "createDelegation").mockImplementation(async (input) => {
      const record = await create(input);
      written.resolve(undefined);
      await release.promise;
      return record;
    });
    try {
      const starting = value.coordinator.start({
        harnessId: "pi",
        parentThreadId: "parent",
        cwd: "/synthetic",
        task: "Create child",
      });
      await written.promise;
      expect(value.treeChanged).not.toHaveBeenCalled();
      release.resolve(undefined);
      const result = await starting;
      expect(value.treeChanged).toHaveBeenCalledExactlyOnceWith(result.threadId);
      expect(
        await value.repository.getDelegationByChild(hostThreadIdSchema.parse(result.threadId)),
      ).toMatchObject({ parentHostThreadId: "parent" });
      expect(value.notifications).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      await value.close();
    }
  });
  it("carries the display name through the real CLI HTTP endpoint and persists it separately from the task", async () => {
    const value = await fixture(undefined, async () => ({ title: "Main project" }));
    const server = await startDelegationControlServer({
      token: "test-token",
      api: value.coordinator,
    });
    try {
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (chunk: Buffer) => chunks.push(chunk));
      expect(
        await runDelegationCli({
          arguments: [
            "delegate",
            "start",
            "--harness",
            "pi",
            "--task-name",
            "Protocol review",
            "--task",
            "Full instructions\nwith details",
            "--parent-thread",
            "parent-thread",
          ],
          environment: {
            CODEXHOST_RUNTIME_ENDPOINT: server.endpoint,
            CODEXHOST_RUNTIME_TOKEN: "test-token",
          },
          output,
        }),
      ).toBe(0);
      const result = JSON.parse(Buffer.concat(chunks).toString()) as {
        threadId: string;
        title: string;
      };
      expect(result.title).toBe("Protocol review");
      expect(await value.repository.find(result.threadId)).toMatchObject({
        title: "Protocol review",
      });
      expect(value.delivered).toEqual(["Full instructions\nwith details"]);
      expect(value.notifications[0]).toMatchObject({ name: "Protocol review" });
    } finally {
      await server.close();
      await value.close();
    }
  });

  it("saves only the subtask name without changing task delivery or retry identity", async () => {
    const value = await fixture();
    try {
      const parent = await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("named-parent"),
        createRequestId: "named-parent",
        harnessId: harnessIdSchema.parse("pi"),
        cwd: "/synthetic",
        title: "Project review",
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "paginated",
      });
      const input = {
        harnessId: "pi" as const,
        task: "Full task instructions\nKeep all details",
        taskName: "Protocol review",
        parentThreadId: parent.hostThreadId,
        requestId: "named-child",
      };
      const result = await value.coordinator.start(input);
      expect(result.title).toBe("Protocol review");
      expect(await value.repository.find(result.threadId)).toMatchObject({
        title: "Protocol review",
      });
      expect(value.notifications[0]).toMatchObject({ name: "Protocol review" });
      await value.repository.setTitle(parent.hostThreadId, "Renamed parent");
      expect(
        await value.coordinator.start({ ...input, taskName: "Changed display name" }),
      ).toMatchObject({ threadId: result.threadId });
      expect(value.adapter.sessions).toHaveLength(1);
      expect(await value.repository.find(result.threadId)).toMatchObject({
        title: "Protocol review",
      });
      const next = await value.coordinator.start({
        harnessId: input.harnessId,
        parentThreadId: input.parentThreadId,
        task: "Next task\nDetails excluded from title",
        requestId: "next-child",
      });
      expect(await value.repository.find(next.threadId)).toMatchObject({
        title: "Next task",
      });
    } finally {
      await value.close();
    }
  });

  it.each([
    { title: "", preview: "  现在有一个问题，\n帮我理解  " },
    { title: " \n ", preview: "First message" },
    { title: undefined, preview: "First message" },
    { title: "Named parent", preview: "First message" },
    { title: "", preview: " \n " },
    { title: "", preview: undefined },
  ])(
    "does not append or change the parent title or preview ($title, $preview)",
    async ({ title, preview }) => {
      const value = await fixture();
      try {
        const parent = await value.repository.createProvisional({
          hostThreadId: hostThreadIdSchema.parse("preview-parent"),
          createRequestId: "preview-parent",
          harnessId: harnessIdSchema.parse("pi"),
          cwd: "/synthetic",
          ...(title !== undefined ? { title } : {}),
          transportModelId: "codexhost/pi-native",
          ephemeral: false,
          historyMode: "paginated",
        });
        if (preview !== undefined) {
          await value.repository.updateMetadata(parent.hostThreadId, { preview });
        }
        const result = await value.coordinator.start({
          harnessId: "pi",
          task: "Full task instructions",
          taskName: "删除 Skill 命令链路",
          parentThreadId: parent.hostThreadId,
        });
        const childTitle = "删除 Skill 命令链路";
        expect(result.title).toBe(childTitle);
        expect(await value.repository.find(result.threadId)).toMatchObject({ title: childTitle });
        expect(value.notifications[0]).toMatchObject({ name: childTitle });
        expect((await value.repository.find(parent.hostThreadId))?.title).toBe(parent.title);
        expect(value.delivered).toEqual(["Full task instructions"]);
      } finally {
        await value.close();
      }
    },
  );

  it("excludes long native parent titles from the subtask name", async () => {
    const value = await fixture(undefined, async () => ({ title: "🐙".repeat(150) }));
    try {
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "Detailed instructions",
        taskName: "Tool test",
        parentThreadId: "native-parent",
      });
      const record = await value.repository.find(result.threadId);
      expect(record?.title).toBe("Tool test");
    } finally {
      await value.close();
    }
  });

  it("rejects invalid task names before opening a session", async () => {
    const value = await fixture();
    try {
      for (const taskName of ["", "  ", "x".repeat(121), 123]) {
        await expect(
          value.coordinator.start({
            harnessId: "pi",
            task: "Task",
            taskName: taskName as string,
            parentThreadId: "parent",
          }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      }
      expect(value.adapter.sessions).toHaveLength(0);
    } finally {
      await value.close();
    }
  });

  it("creates a normal writable child Thread and publishes it only after initial delivery", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const inspect = vi.spyOn(adapter, "inspect");
    const value = await fixture(adapter);
    try {
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      expect(result).toMatchObject({
        harnessId: "pi",
        status: "running",
        cwd: path.resolve("/synthetic"),
        parentThreadId: "parent-thread",
      });
      expect(inspect).not.toHaveBeenCalled();
      await expect(value.coordinator.listHarnesses()).resolves.toEqual({
        harnesses: ["codex", "pi"],
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(value.registered).toHaveLength(1);
      expect(value.notifications).toHaveLength(1);
      expect(value.adapter.sessions).toHaveLength(1);
      expect(adapter.openInputs).toContainEqual(
        expect.objectContaining({
          kind: "create",
          executionPolicy: "unattended-full-access",
        }),
      );
      expect(adapter.openInputs[0]).not.toHaveProperty("model");
      expect(adapter.openInputs[0]).not.toHaveProperty("thinkingOptionId");
      const records = await value.repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.subagent).toBeUndefined();
      expect(
        await value.repository.getDelegationByChild(hostThreadIdSchema.parse(result.threadId)),
      ).toMatchObject({
        parentHostThreadId: "parent-thread",
        childHostThreadId: result.threadId,
        status: "running",
      });
    } finally {
      await value.close();
    }
  });

  it("receives, persists, and resumes WorkBuddy delegation through the ordinary Thread path", async () => {
    const environment = {
      CODEXHOST_CLI_PATH: "/opt/codexhost/bin/codexhost",
      CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
      CODEXHOST_RUNTIME_TOKEN: "runtime-token",
    };
    const adapter = new RecordingAdapter(harnessIdSchema.parse("workbuddy"));
    const value = await fixture(adapter, async () => undefined, environment);
    let restoredRuntime: ExternalThreadRuntime | undefined;
    try {
      await expect(value.coordinator.listHarnesses()).resolves.toEqual({
        harnesses: ["codex", "workbuddy"],
      });
      const started = await value.coordinator.start({
        harnessId: "workbuddy",
        task: "delegate through WorkBuddy",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      expect(started).toMatchObject({
        harnessId: "workbuddy",
        status: "running",
        deepLink: `codex://threads/${started.threadId}`,
      });
      expect(adapter.openInputs[0]).toMatchObject({
        kind: "create",
        executionPolicy: "unattended-full-access",
        environment: {
          ...environment,
          CODEXHOST_THREAD_ID: started.threadId,
        },
      });
      await expect(value.repository.find(started.threadId)).resolves.toMatchObject({
        harnessId: "workbuddy",
        state: "ready",
        nativeSessionRef: { harnessId: "workbuddy" },
      });

      const session = adapter.sessions[0];
      if (!session) throw new Error("WorkBuddy delegation did not open a Session");
      session.succeedTurn();
      value.runtime.clear();
      const adapters = new Map<ExternalHarnessId, HarnessAdapter>([["workbuddy", adapter]]);
      restoredRuntime = new ExternalThreadRuntime({
        adapters,
        environment,
        repository: value.repository,
        consumeOutputs: async () => undefined,
        diagnose: () => undefined,
      });
      const restored = await restoredRuntime.resolve(started.threadId);
      expect(restored.kind).toBe("external");
      if (restored.kind !== "external") throw new Error("WorkBuddy delegation did not resume");
      expect(restored.thread.harnessId).toBe("workbuddy");
      expect(adapter.openInputs.at(-1)).toMatchObject({
        kind: "resume",
        environment: {
          ...environment,
          CODEXHOST_THREAD_ID: started.threadId,
        },
        nativeRef: { harnessId: "workbuddy" },
      });
    } finally {
      restoredRuntime?.clear();
      await adapter.close();
      await value.close();
    }
  });

  it("resolves delegated cwd from explicit input, external and official parents, then process cwd", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const officialThreadCwd = vi.fn(async (threadId: string) =>
      threadId === "official-parent" ? "/official-workspace" : undefined,
    );
    const value = await fixture(adapter, officialThreadCwd);
    try {
      await value.repository.createProvisional({
        hostThreadId: hostThreadIdSchema.parse("stored-parent"),
        createRequestId: "stored-parent-request",
        harnessId: harnessIdSchema.parse("pi"),
        cwd: "/parent-workspace",
        title: "parent",
        transportModelId: "codexhost/pi-native",
        ephemeral: false,
        historyMode: "paginated",
      });

      await value.coordinator.start({
        harnessId: "pi",
        task: "inherit external cwd",
        parentThreadId: "stored-parent",
      });
      await value.coordinator.start({
        harnessId: "pi",
        task: "explicit cwd",
        cwd: "/explicit-workspace",
        parentThreadId: "stored-parent",
      });
      await value.coordinator.start({
        harnessId: "pi",
        task: "inherit official cwd",
        parentThreadId: "official-parent",
      });
      await value.coordinator.start({
        harnessId: "pi",
        task: "fallback cwd",
        parentThreadId: "missing-parent",
      });

      expect(adapter.openInputs.map((input) => input.cwd)).toEqual([
        path.resolve("/parent-workspace"),
        path.resolve("/explicit-workspace"),
        path.resolve("/official-workspace"),
        path.resolve(process.cwd()),
      ]);
      expect(officialThreadCwd.mock.calls.map(([threadId]) => threadId)).toEqual([
        "official-parent",
        "missing-parent",
      ]);
    } finally {
      await value.close();
    }
  });

  it("inspects and applies an explicit Model and Thinking selection", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const value = await fixture(adapter);
    try {
      const inspection = await value.coordinator.inspect({ harnessId: "pi", cwd: "/synthetic" });
      expect(inspection.inspection.status).toBe("ready");
      if (inspection.inspection.status !== "ready") throw new Error("Harness is unavailable");
      const model = inspection.inspection.catalog.defaultModel;
      const thinkingOptionId = inspection.inspection.catalog.defaultThinkingOptionId;
      if (!model || !thinkingOptionId) throw new Error("Fake catalog has no defaults");
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        model: model.id,
        thinking: thinkingOptionId,
      });
      expect(adapter.openInputs[0]).toMatchObject({ model, thinkingOptionId });
      expect(result.configuration?.requested).toEqual({ model, thinkingOptionId });
      expect((await value.repository.list())[0]?.transportModelId).not.toBe("codexhost/pi-native");
    } finally {
      await value.close();
    }
  });

  it("resolves explicit native Model and Thinking selectors from HTTP delegate start", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), nativeSelectionCatalog());
    const value = await fixture(adapter);
    const server = await startDelegationControlServer({
      token: "test-token",
      api: value.coordinator,
    });
    try {
      const response = await fetch(`${server.endpoint}/v1/delegate/start`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          harnessId: "pi",
          task: "review auth",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
          model: "provider/model-a",
          thinking: "reasoning=high",
        }),
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { configuration?: { requested?: unknown } }).configuration
          ?.requested,
      ).toEqual({ model: { id: "encoded-model" }, thinkingOptionId: "encoded-thinking" });
      expect(adapter.openInputs[0]).toMatchObject({
        model: { id: "encoded-model" },
        thinkingOptionId: "encoded-thinking",
      });
    } finally {
      await server.close();
      await value.close();
    }
  });

  it("resolves explicit native Model and Thinking selectors from MCP delegate_start", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), nativeSelectionCatalog());
    const value = await fixture(adapter);
    const clients = new ExternalClientRegistry(path.join(value.directory, "external-clients.json"));
    const { token } = await clients.add("selection-client");
    const route = externalClientRouter({ api: value.coordinator });
    const server = await startExternalClientServer({
      port: 0,
      clients,
      route,
      streams: { "/mcp": externalClientMcp(route) },
      descriptorPath: path.join(value.directory, "endpoint.json"),
    });
    if (!server) throw new Error("external client listener did not start");
    try {
      const response = await fetch(new URL("/mcp", server.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "delegate_start",
            arguments: {
              harnessId: "pi",
              task: "review auth",
              cwd: "/synthetic",
              parentThread: "parent-thread",
              model: "provider/model-a",
              thinking: "reasoning=high",
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: {
          isError: boolean;
          structuredContent: { configuration?: { requested?: unknown } };
        };
      };
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.configuration?.requested).toEqual({
        model: { id: "encoded-model" },
        thinkingOptionId: "encoded-thinking",
      });
      expect(adapter.openInputs[0]).toMatchObject({
        model: { id: "encoded-model" },
        thinkingOptionId: "encoded-thinking",
      });
    } finally {
      await server.close();
      await value.close();
    }
  });

  it("validates an advertised Fast ref with the same Thinking options and preserves the opaque selection", async () => {
    const catalog = harnessModelCatalogSchema.parse({
      models: [
        {
          ref: { id: "normal" },
          fastModel: { id: "priority" },
          label: "Model",
          supportedThinkingOptionIds: ["high"],
        },
      ],
      thinkingOptions: [{ id: "high", label: "High" }],
    });
    const model = catalog.models[0]?.fastModel;
    const thinkingOptionId = catalog.thinkingOptions[0]?.id;
    if (!model || !thinkingOptionId) throw new Error("Missing fixture selections");
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), catalog);
    const value = await fixture(adapter);
    try {
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "fixture task",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        model: model.id,
        thinking: thinkingOptionId,
      });
      expect(result.configuration).toMatchObject({
        requested: { model, thinkingOptionId },
        effective: { effectiveModel: model, effectiveThinkingOptionId: thinkingOptionId },
      });
      expect(adapter.openInputs[0]).toMatchObject({ model, thinkingOptionId });
    } finally {
      await value.close();
    }
  });

  it("deduplicates explicit and implicit retries but not different task text", async () => {
    const value = await fixture();
    try {
      const first = await value.coordinator.start({
        harnessId: "pi",
        task: "task one",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "request-1",
      });
      const explicitRetry = await value.coordinator.start({
        harnessId: "pi",
        task: "task one",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "request-1",
      });
      const implicit = await value.coordinator.start({
        harnessId: "pi",
        task: "task two",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const implicitRetry = await value.coordinator.start({
        harnessId: "pi",
        task: "task two",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const different = await value.coordinator.start({
        harnessId: "pi",
        task: "task three",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      expect(explicitRetry.threadId).toBe(first.threadId);
      expect(implicitRetry.threadId).toBe(implicit.threadId);
      expect(different.threadId).not.toBe(implicit.threadId);
      expect(value.adapter.sessions).toHaveLength(3);
    } finally {
      await value.close();
    }
  });

  it("retries a native selector with its opaque equivalent without reading the catalog again", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), nativeSelectionCatalog());
    const value = await fixture(adapter);
    const inspect = vi.spyOn(adapter, "inspect");
    try {
      const native = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "equivalent-selectors",
        model: "provider/model-a",
        thinking: "reasoning=high",
      });
      expect(inspect).toHaveBeenCalledTimes(1);
      inspect.mockRejectedValue(new Error("Catalog is unavailable"));
      const opaque = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "equivalent-selectors",
        model: "encoded-model",
        thinking: "encoded-thinking",
      });
      expect(opaque.threadId).toBe(native.threadId);
      expect(adapter.sessions).toHaveLength(1);
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally {
      await value.close();
    }
  });

  it("collapses equivalent native and opaque selectors into one implicit delegation", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"), nativeSelectionCatalog());
    const value = await fixture(adapter);
    try {
      const native = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        model: "provider/model-a",
        thinking: "reasoning=high",
      });
      const opaque = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        model: "encoded-model",
        thinking: "encoded-thinking",
      });
      expect(opaque.threadId).toBe(native.threadId);
      expect(adapter.sessions).toHaveLength(1);
    } finally {
      await value.close();
    }
  });

  it("retries a delegation stored with the pre-selector digest", async () => {
    const value = await fixture();
    try {
      const task = "legacy task";
      const modelId = "encoded-model";
      const thinkingOptionId = "encoded-thinking";
      const taskDigest = createHash("sha256")
        .update(
          JSON.stringify({
            task,
            cwd: path.resolve("/synthetic"),
            modelId,
            thinkingOptionId,
          }),
        )
        .digest("hex");
      await value.repository.createDelegation({
        delegationId: hostThreadIdSchema.parse("legacy-delegation"),
        parentHostThreadId: hostThreadIdSchema.parse("parent-thread"),
        childHostThreadId: hostThreadIdSchema.parse("legacy-child"),
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("pi"),
        status: "running",
        requestId: "legacy-request",
        taskDigest,
      });
      const retry = await value.coordinator.start({
        harnessId: "pi",
        task,
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "legacy-request",
        model: modelId,
        thinking: thinkingOptionId,
      });
      expect(retry.threadId).toBe("legacy-child");
      expect(value.adapter.sessions).toHaveLength(0);
    } finally {
      await value.close();
    }
  });

  it("sends follow-up Turns, rejects busy sends, and cancels the active Turn", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing delegated Session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing delegated Thread");
      thread.running = false;
      thread.activeTurnId = null;

      const followUp = await value.coordinator.send({
        threadId: started.threadId,
        message: "continue",
      });
      expect(followUp).toMatchObject({
        threadId: started.threadId,
        harnessId: "pi",
        status: "running",
      });
      await expect(
        value.coordinator.send({ threadId: started.threadId, message: "again" }),
      ).rejects.toMatchObject({ code: "THREAD_BUSY" });
      await expect(value.coordinator.cancel({ threadId: started.threadId })).resolves.toMatchObject(
        {
          threadId: started.threadId,
          turnId: followUp.turnId,
          cancelled: true,
        },
      );
      session.completeCancellation();
      thread.running = false;
      thread.activeTurnId = null;
      await expect(value.coordinator.cancel({ threadId: started.threadId })).resolves.toMatchObject(
        {
          turnId: null,
          cancelled: false,
        },
      );
    } finally {
      await value.close();
    }
  });

  it("rolls back Session, Thread, and Delegation when initial task delivery fails", async () => {
    const value = await fixture(new FailingTurnAdapter(harnessIdSchema.parse("pi")));
    try {
      await expect(
        value.coordinator.start({
          harnessId: "pi",
          task: "fail delivery",
          cwd: "/synthetic",
          parentThreadId: "parent-thread",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_FAILED" });
      expect(value.notifications).toHaveLength(0);
      expect(value.runtime.values()).toHaveLength(0);
      await expect(value.repository.list()).resolves.toHaveLength(0);
      await expect(value.repository.listDelegations()).resolves.toHaveLength(0);
    } finally {
      await value.close();
    }
  });

  it("lists native and external children from Delegation lineage", async () => {
    const value = await fixture();
    try {
      await value.coordinator.start({
        harnessId: "pi",
        task: "external child",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      await value.repository.createDelegation({
        delegationId: hostThreadIdSchema.parse("native-delegation"),
        parentHostThreadId: hostThreadIdSchema.parse("parent-thread"),
        childHostThreadId: hostThreadIdSchema.parse("native-child"),
        sourceHarnessId: harnessIdSchema.parse("pi"),
        targetHarnessId: harnessIdSchema.parse("codex"),
        status: "running",
        taskDigest: "a".repeat(64),
      });
      await expect(
        value.coordinator.list({
          parentThreadId: "parent-thread",
          limit: 25,
          sort: "created-desc",
        }),
      ).resolves.toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({ harnessId: "pi" }),
          expect.objectContaining({ threadId: "native-child", harnessId: "codex" }),
        ]),
      });
    } finally {
      await value.close();
    }
  });

  it("wait returns terminal snapshots early and running snapshots on timeout without writing", async () => {
    const value = await fixture();
    try {
      const read = vi.spyOn(value.coordinator, "read");
      read.mockResolvedValueOnce({
        threadId: "thread-1",
        harnessId: "pi",
        status: "completed",
        turn: { turnId: "turn-1", status: "completed" },
        progress: [],
        result: { availability: "available", text: "done" },
      });
      await expect(
        value.coordinator.wait({
          threadId: "thread-1",
          view: "result",
          timeoutMs: 100,
        }),
      ).resolves.toMatchObject({ timedOut: false, status: "completed" });

      read.mockRestore();
      const running = vi.spyOn(value.coordinator, "read").mockResolvedValue({
        threadId: "thread-1",
        harnessId: "pi",
        status: "running",
        turn: { turnId: "turn-1", status: "running" },
        progress: [],
        result: { availability: "pending" },
      });
      await expect(
        value.coordinator.wait({
          threadId: "thread-1",
          view: "result",
          timeoutMs: 1,
        }),
      ).resolves.toMatchObject({ timedOut: true, status: "running" });
      expect(running).toHaveBeenCalled();
    } finally {
      await value.close();
    }
  });

  it.each(["result", "messages"] as const)(
    "preserves history recovery errors when reading %s",
    async (view) => {
      const value = await fixture();
      try {
        const started = await value.coordinator.start({
          harnessId: "pi",
          task: "synthetic history recovery",
          parentThreadId: "parent",
        });
        const session = value.adapter.sessions[0];
        if (!session) throw new Error("Missing delegated Session");
        session.succeedTurn();
        const message = "Synthetic history active branch references a missing Entry";
        vi.spyOn(session, "readSnapshot").mockResolvedValue({
          ok: false,
          error: { code: "nativeFailure", message, retryable: true },
        });
        value.runtime.clear();
        await expect(value.repository.find(started.threadId)).resolves.toMatchObject({
          state: "ready",
        });
        const recoveryError = {
          code: "INTERNAL_ERROR",
          message: "External Thread read failed",
        };
        await expect(
          value.coordinator.read({ threadId: started.threadId, view }),
        ).rejects.toMatchObject(recoveryError);
        await expect(
          value.coordinator.wait({ threadId: started.threadId, view, timeoutMs: 100 }),
        ).rejects.toMatchObject(recoveryError);
      } finally {
        await value.close();
      }
    },
  );

  it("retains a missing-Thread error if an external mapping vanishes during resolution", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "synthetic missing mapping",
        parentThreadId: "parent",
      });
      vi.spyOn(value.runtime, "resolve").mockResolvedValue({ kind: "official" });
      await expect(
        value.coordinator.read({ threadId: started.threadId, view: "result" }),
      ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND", message: "Thread was not found" });
    } finally {
      await value.close();
    }
  });

  it("exports full live and historical Host items without changing the normal read view", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "work",
        parentThreadId: "parent",
      });
      const thread = value.registered[0];
      if (!thread) throw new Error("delegated Thread was not registered");
      const turnId = hostTurnIdSchema.parse(started.turnId);
      const projector = new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs: Date.now(),
        initialInput: [{ type: "text", text: "work" }],
      });
      projector.project({ type: "turn.started", turnId });
      projector.project({
        type: "item.started",
        turnId,
        item: { type: "reasoning", itemId: hostItemIdSchema.parse("r1"), text: "live reasoning" },
      });
      projector.project({
        type: "item.started",
        turnId,
        item: {
          type: "commandExecution",
          itemId: hostItemIdSchema.parse("c1"),
          command: "ls",
          output: "live tool output",
        },
      });
      thread.projectedTurns.set(turnId, { projector });
      thread.turns = [
        {
          id: "older-turn",
          status: "completed",
          items: [
            {
              type: "mcpToolCall",
              tool: "historical-tool",
              result: { content: "historical output" },
            },
          ],
        },
      ];
      const live = await value.coordinator.exportThread({
        threadId: thread.id,
        out: path.join(value.directory, "live.json"),
      });
      expect(live).toMatchObject({ harnessId: "pi", turns: 2, complete: false });
      const document = JSON.parse(await readFile(live.path, "utf8"));
      expect(document.turns[0]).toEqual(thread.turns[0]);
      expect(document.turns[1]).toEqual(projector.snapshotTurn());
      expect(document.turns[1].items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reasoning", summary: ["live reasoning"] }),
          expect.objectContaining({
            type: "commandExecution",
            command: "ls",
            aggregatedOutput: "live tool output",
          }),
        ]),
      );
      expect(
        await value.coordinator.read({ threadId: thread.id, view: "messages" }),
      ).not.toHaveProperty("thread");
      thread.running = false;
      thread.activeTurnId = null;
      thread.turns.push({ ...projector.snapshotTurn(), status: "completed" });
      vi.spyOn(value.runtime, "refresh").mockResolvedValue(null);
      const complete = await value.coordinator.exportThread({
        threadId: thread.id,
        out: path.join(value.directory, "complete.json"),
      });
      expect(complete.complete).toBe(true);
      expect(JSON.parse(await readFile(complete.path, "utf8")).turns).toEqual(thread.turns);
    } finally {
      await value.close();
    }
  });

  it("reads the projected terminal Turn when a dead Harness cannot serve its history", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "work",
        parentThreadId: "parent",
      });
      const thread = value.registered[0];
      if (!thread) throw new Error("delegated Thread was not registered");
      expect(value.coordinator.activeThreadIds()).toEqual([started.threadId]);
      // The Adapter completed the Turn as failed, then its process died.
      thread.running = false;
      thread.activeTurnId = null;
      thread.historyHydrated = false;
      thread.turns = [
        { id: started.turnId, status: "failed", items: [], error: { message: "process exited" } },
      ];
      thread.projectedTerminalTurnId = hostTurnIdSchema.parse(started.turnId);
      vi.spyOn(thread.session, "readSnapshot").mockResolvedValue({
        ok: false,
        error: { code: "nativeFailure", message: "Harness is gone", retryable: false },
      });

      await expect(
        value.coordinator.read({ threadId: started.threadId, view: "result" }),
      ).resolves.toMatchObject({
        status: "failed",
        turn: { turnId: started.turnId, status: "failed" },
        result: { availability: "unavailable", message: "process exited" },
      });

      // Only the marked terminal Turn may answer: not a different latest Turn…
      thread.turns = [...thread.turns, { id: "later-native-turn", status: "completed", items: [] }];
      await expect(
        value.coordinator.read({ threadId: started.threadId, view: "result" }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      // …nor the older Turn once a later start cleared the mark.
      thread.turns = thread.turns.slice(0, 1);
      thread.projectedTerminalTurnId = null;
      await expect(
        value.coordinator.read({ threadId: started.threadId, view: "result" }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    } finally {
      await value.close();
    }
  });

  it("reads a pending steer replacement as running and keeps the delegation running", async () => {
    const value = await fixture(
      new FakeHarnessAdapter(harnessIdSchema.parse("pi")),
      async () => undefined,
      {},
      () => true,
    );
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "work",
        parentThreadId: "parent",
      });
      const thread = value.registered[0];
      if (!thread) throw new Error("delegated Thread was not registered");
      // Old Turn has ended; the replacement Turn has not started.
      thread.running = false;
      thread.activeTurnId = null;
      thread.turns = [{ id: started.turnId, status: "interrupted", items: [] }];
      // Parent inference must still see the Thread as the active caller.
      expect(value.coordinator.activeThreadIds()).toEqual([started.threadId]);

      await expect(
        value.coordinator.read({ threadId: started.threadId, view: "result" }),
      ).resolves.toMatchObject({ status: "running" });
      await expect(
        value.repository.getDelegationByChild(hostThreadIdSchema.parse(started.threadId)),
      ).resolves.toMatchObject({ status: "running" });
    } finally {
      await value.close();
    }
  });
  it("starts work for an external client as its own origin and lists it by that origin", async () => {
    const metadata = vi.fn(async () => undefined);
    const value = await fixture(undefined, metadata);
    try {
      await expect(
        value.coordinator.start({
          harnessId: "pi",
          task: "triage",
          parentThreadId: "client:grok-bot",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("--cwd"),
      });

      const input = {
        harnessId: "pi" as const,
        task: "triage issue 12",
        cwd: "/synthetic",
        parentThreadId: "client:grok-bot",
      };
      const result = await value.coordinator.start(input);
      expect(result).toMatchObject({ parentThreadId: "client:grok-bot", status: "running" });
      await expect(value.repository.find(result.threadId)).resolves.toMatchObject({
        title: "triage issue 12",
      });
      expect(metadata).not.toHaveBeenCalled();
      // A retry from the same client within the window returns the same child.
      await expect(value.coordinator.start(input)).resolves.toMatchObject({
        threadId: result.threadId,
      });
      await expect(
        value.coordinator.list({
          parentThreadId: "client:grok-bot",
          limit: 25,
          sort: "created-desc",
        }),
      ).resolves.toMatchObject({ threads: [{ threadId: result.threadId }] });
    } finally {
      await value.close();
    }
  });
});
