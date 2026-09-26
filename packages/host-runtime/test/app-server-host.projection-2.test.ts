import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  harnessModelRefSchema,
  harnessThinkingOptionIdSchema,
  hostThreadIdSchema,
} from "@codexhost/shared-contracts";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { type CodexAccountControl } from "../src/account/codex-account-control.js";

import {
  FailingOwnershipMappingStore,
  FailingArchiveMappingStore,
  FailingListMappingStore,
  FailingDelegationMappingStore,
  JsonLineCollector,
  method,
  requestId,
  messageParams,
  turnEvent,
  writeRequest,
  readJsonLine,
  WebUiHarnessAdapter,
  ModernSessionImportAdapter,
  createFixture,
  startExternalThread,
  startPiThread,
  startPiTurn,
  completePiTurn,
  closeFixture,
  stopFixture,
  bindOfficialThread,
  answerOfficialParentCwd,
} from "./app-server-host-fixture.js";

describe("AppServerHost HarnessAdapter projection", () => {
  it("dispatches inspection by registered Harness ID and rejects unknown Harnesses", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });

    writeRequest(fixture.desktopInput, {
      id: 31,
      method: "codexhost/harness/inspect",
      params: { harnessId: "claude-code", cwd: "/synthetic-claude" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 31)),
    ).resolves.toMatchObject({ result: { status: "ready" } });
    expect(claude.inspectionCalls).toBe(1);
    expect(pi.inspectionCalls).toBe(0);

    writeRequest(fixture.desktopInput, {
      id: 32,
      method: "codexhost/harness/inspect",
      params: { harnessId: "unregistered" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 32)),
    ).resolves.toMatchObject({
      error: { code: -32077, message: "Harness 'unregistered' is unavailable" },
    });
    await stopFixture(fixture);
  });

  it("opens a Harness Web UI without returning or echoing its credential", async () => {
    const adapter = new WebUiHarnessAdapter(harnessIdSchema.parse("deepseek-harness"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["deepseek-harness", adapter],
      ]),
    });

    writeRequest(fixture.desktopInput, {
      id: 37,
      method: "codexhost/harness/web-ui/open",
      params: { harnessId: "deepseek-harness" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 37))).resolves.toEqual({
      id: 37,
      result: {},
    });
    expect(adapter.openCalls).toBe(1);

    const canary = "SECRET_CANARY";
    writeRequest(fixture.desktopInput, {
      id: 38,
      method: "codexhost/harness/web-ui/open",
      params: { harnessId: "deepseek-harness", url: `http://127.0.0.1/?token=${canary}` },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 38)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(adapter.openCalls).toBe(1);

    adapter.failureMessage = `failed near ?token=${canary}`;
    writeRequest(fixture.desktopInput, {
      id: 39,
      method: "codexhost/harness/web-ui/open",
      params: { harnessId: "deepseek-harness" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 39))).resolves.toEqual({
      id: 39,
      error: { code: -32092, message: "Harness Web UI could not be opened" },
    });
    expect(JSON.stringify(fixture.collector.messages)).not.toContain(canary);
    await stopFixture(fixture);
  });

  it("lists and imports a Modern DeepSeek Session as notLoaded metadata", async () => {
    const adapter = new ModernSessionImportAdapter(harnessIdSchema.parse("deepseek-harness"));
    adapter.candidates = [
      {
        nativeSessionId: "native-import",
        title: "Imported history",
        updatedAt: 123,
        cwd: path.resolve("import-workspace"),
        running: false,
      },
    ];
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["deepseek-harness", adapter],
      ]),
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 40,
      method: "codexhost/deepseek/modern-session/list",
      params: {},
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 40))).resolves.toEqual({
      id: 40,
      result: { candidates: adapter.candidates },
    });
    writeRequest(fixture.desktopInput, {
      id: 41,
      method: "codexhost/deepseek/modern-session/import",
      params: { nativeSessionId: "native-import" },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 41));
    expect(response).toMatchObject({ result: { threadId: expect.any(String) } });
    const threadId = (response.result as JsonObject).threadId;
    const started = await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.id === threadId,
    );
    expect(messageParams(started).thread).toMatchObject({
      id: threadId,
      status: { type: "notLoaded" },
      cwd: path.resolve("import-workspace"),
      name: "Imported history",
      turns: [],
    });
    expect(fixture.collector.messages.indexOf(response)).toBeLessThan(
      fixture.collector.messages.indexOf(started),
    );
    expect(adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();

    writeRequest(fixture.desktopInput, {
      id: 43,
      method: "codexhost/deepseek/modern-session/import",
      params: { nativeSessionId: "native-import" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 43))).resolves.toEqual({
      id: 43,
      result: { threadId },
    });
    expect(
      fixture.collector.messages.filter(
        (message) =>
          method(message, "thread/started") &&
          (messageParams(message).thread as JsonObject | undefined)?.id === threadId,
      ),
    ).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("rejects invalid Modern DeepSeek import params before calling the Adapter", async () => {
    const adapter = new ModernSessionImportAdapter(harnessIdSchema.parse("deepseek-harness"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["deepseek-harness", adapter],
      ]),
    });

    writeRequest(fixture.desktopInput, {
      id: 42,
      method: "codexhost/deepseek/modern-session/import",
      params: { nativeSessionId: "", cwd: "/untrusted" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 42)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(adapter.listCandidates).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("answers a later Harness inspect while an earlier inspect is still running", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    let releaseClaude = (): void => undefined;
    const claudeReady = new Promise<void>((resolve) => {
      releaseClaude = resolve;
    });
    const inspectClaude = claude.inspect.bind(claude);
    claude.inspect = async (input) => {
      await claudeReady;
      return inspectClaude(input);
    };
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });

    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "codexhost/harness/inspect",
      params: { harnessId: "claude-code" },
    });
    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "codexhost/harness/inspect",
      params: { harnessId: "pi" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({ result: { status: "ready" } });
    expect(fixture.collector.messages.some((message) => requestId(message, 33))).toBe(false);
    expect(pi.inspectionCalls).toBe(1);

    releaseClaude();
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({ result: { status: "ready" } });
    await stopFixture(fixture);
  });

  it("answers a Harness inspect while official thread/list is still pending", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 35,
      method: "thread/list",
      params: { limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    writeRequest(fixture.desktopInput, {
      id: 36,
      method: "codexhost/harness/inspect",
      params: { harnessId: "pi" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 36)),
    ).resolves.toMatchObject({ result: { status: "ready" } });
    expect(fixture.collector.messages.some((message) => requestId(message, 35))).toBe(false);
    await stopFixture(fixture);
  });

  it("projects delegated input while reading visible progress from a running external Turn", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const starting = delegationApi.start({
      harnessId: "pi",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    const started = await starting;
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Delegated Session was not opened");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "turn/started") &&
          (message.params as JsonObject).threadId === started.threadId,
      ),
    ).resolves.toMatchObject({
      params: {
        turn: {
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "review auth" }],
            },
          ],
        },
      },
    });
    session.appendText("Checking auth.");
    await expect(
      delegationApi.read({ threadId: started.threadId, view: "result" }),
    ).resolves.toMatchObject({
      status: "running",
      progress: [expect.objectContaining({ text: "Checking auth." })],
      result: { availability: "pending" },
    });
    session.succeedTurn();
    const completed = await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/completed") &&
        (message.params as JsonObject).threadId === started.threadId,
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "review auth" }],
            },
            { type: "agentMessage", text: "Checking auth." },
          ],
        },
      },
    });
    const completedItems = (
      (completed.params as JsonObject).turn as { items: Array<{ id?: string; type?: string }> }
    ).items;
    expect(completedItems.filter((item) => item.type === "userMessage")).toHaveLength(1);
    expect(new Set(completedItems.map((item) => item.id)).size).toBe(completedItems.length);

    // Delegated external Threads use paginated history; read via turns/list.
    writeRequest(fixture.desktopInput, {
      id: 1057,
      method: "thread/turns/list",
      params: { threadId: started.threadId, limit: 20, itemsView: "full" },
    });
    const listed = await fixture.collector.waitFor((message) => requestId(message, 1057));
    expect(listed).toMatchObject({
      result: {
        data: [
          {
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: "review auth" }],
              },
              { type: "agentMessage", text: "Checking auth." },
            ],
          },
        ],
      },
    });
    const storedItems =
      (listed as { result: { data: Array<{ items: Array<{ id?: string; type?: string }> }> } })
        .result.data[0]?.items ?? [];
    expect(storedItems.filter((item) => item.type === "userMessage")).toHaveLength(1);
    expect(new Set(storedItems.map((item) => item.id)).size).toBe(storedItems.length);
    await stopFixture(fixture);
  });

  it("inherits cwd from a native Codex parent when delegation omits cwd", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    if (!delegationApi) throw new Error("Delegation API was not registered");
    await bindOfficialThread(fixture, "native-parent");

    const pending = delegationApi.start({
      harnessId: "pi",
      task: "inherit workspace",
      parentThreadId: "native-parent",
    });
    const read = await readJsonLine(fixture.official.stdin);
    expect(read).toMatchObject({
      method: "thread/read",
      params: { threadId: "native-parent" },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: read.id,
        result: { thread: { id: "native-parent", cwd: "/native-workspace" } },
      })}\n`,
    );

    await expect(pending).resolves.toMatchObject({ harnessId: "pi", status: "running" });
    expect(fixture.adapter.sessions[0]?.cwd).toBe(path.resolve("/native-workspace"));
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("lists native and external Threads through the delegation CLI list surface", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const externalThreadId = await startPiThread(fixture);

    const pending = delegationApi.list({ cwd: "/synthetic", limit: 25, sort: "created-desc" });
    const request = await readJsonLine(fixture.official.stdin);
    expect(request).toMatchObject({
      method: "thread/list",
      params: { cwd: ["/synthetic"], limit: 25, sortKey: "created_at", sortDirection: "desc" },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          data: [
            {
              id: "native-thread",
              cwd: "/synthetic",
              name: "Native",
              createdAt: 2_000,
              updatedAt: 2_000,
              status: { type: "idle" },
            },
          ],
          nextCursor: null,
        },
      })}\n`,
    );
    await expect(pending).resolves.toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({ threadId: externalThreadId, harnessId: "pi" }),
        expect.objectContaining({ threadId: "native-thread", harnessId: "codex" }),
      ]),
    });
    await stopFixture(fixture);
  });

  it("sends and cancels follow-up Turns on an external delegated Thread", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const starting = delegationApi.start({
      harnessId: "pi",
      task: "first",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    const started = await starting;
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Delegated Session was not opened");
    session.succeedTurn();
    await vi.waitFor(async () =>
      expect(
        await delegationApi?.read({ threadId: started.threadId, view: "result" }),
      ).toMatchObject({ status: "completed" }),
    );
    const followUp = await delegationApi.send({ threadId: started.threadId, message: "continue" });
    expect(followUp).toMatchObject({ harnessId: "pi", status: "running" });
    await expect(
      delegationApi.send({ threadId: started.threadId, message: "again" }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });
    await expect(delegationApi.cancel({ threadId: started.threadId })).resolves.toMatchObject({
      turnId: followUp.turnId,
      cancelled: true,
    });
    session.completeCancellation();
    await stopFixture(fixture);
  });

  it("sends and cancels follow-up Turns on a native Codex Thread", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    await bindOfficialThread(fixture, "native-child");

    const send = delegationApi.send({ threadId: "native-child", message: "continue" });
    const read = await readJsonLine(fixture.official.stdin);
    expect(read).toMatchObject({
      method: "thread/read",
      params: { threadId: "native-child", includeTurns: true },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: read.id, result: { thread: { id: "native-child" } } })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: { threadId: "native-child", input: [{ type: "text", text: "continue" }] },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "native-turn-2" } } })}\n`,
    );
    await expect(send).resolves.toMatchObject({ turnId: "native-turn-2", status: "running" });
    await expect(
      delegationApi.send({ threadId: "native-child", message: "again" }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });

    const cancel = delegationApi.cancel({ threadId: "native-child" });
    const interrupt = await readJsonLine(fixture.official.stdin);
    expect(interrupt).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "native-child", turnId: "native-turn-2" },
    });
    fixture.official.stdout.write(`${JSON.stringify({ id: interrupt.id, result: {} })}\n`);
    await expect(cancel).resolves.toMatchObject({ turnId: "native-turn-2", cancelled: true });
    await stopFixture(fixture);
  });

  it("inspects native Codex Models and starts with explicit Model and Thinking", async () => {
    const xaiModel = harnessModelRefSchema.parse({
      id: "codex-model-v1.eGFpL2dyb2stNC42",
    });
    const kimiModel = harnessModelRefSchema.parse({
      id: "codex-model-v1.a2ltaS9rM1sxbV0",
    });
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");

    const inspection = delegationApi.inspect({ harnessId: "codex" });
    const modelList = await readJsonLine(fixture.official.stdin);
    expect(modelList).toMatchObject({ method: "model/list", params: {} });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: modelList.id,
        result: {
          data: [
            {
              model: "xai/grok-4.6",
              displayName: "Grok 4.6",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
            },
            {
              model: "kimi/k3[1m]",
              displayName: "Kimi K3",
              supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
            },
          ],
        },
      })}\n`,
    );
    await expect(inspection).resolves.toMatchObject({
      harnessId: "codex",
      inspection: {
        status: "ready",
        catalog: {
          models: [
            { ref: xaiModel, label: "Grok 4.6" },
            { ref: kimiModel, label: "Kimi K3" },
          ],
          defaultModel: xaiModel,
          thinkingOptions: [{ id: "high", label: "High" }],
        },
      },
    });

    const pending = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      model: kimiModel,
      thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
    });
    await answerOfficialParentCwd(fixture);
    const validationList = await readJsonLine(fixture.official.stdin);
    expect(validationList).toMatchObject({ method: "model/list" });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: validationList.id,
        result: {
          data: [
            {
              model: "xai/grok-4.6",
              supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
            },
            {
              model: "kimi/k3[1m]",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
            },
          ],
        },
      })}\n`,
    );
    const threadStart = await readJsonLine(fixture.official.stdin);
    expect(threadStart).toMatchObject({
      method: "thread/start",
      params: { model: "kimi/k3[1m]" },
    });
    expect(threadStart.params).not.toHaveProperty("reasoningEffort");
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: threadStart.id,
        result: {
          thread: { id: "native-configured" },
          model: "kimi/k3[1m]",
        },
      })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: { model: "kimi/k3[1m]", effort: "high" },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "native-turn" } } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({
      configuration: {
        requested: { model: kimiModel, thinkingOptionId: "high" },
        effective: {
          effectiveModel: kimiModel,
        },
      },
    });
    await stopFixture(fixture);
  });

  it("canonicalizes legacy transport-safe Codex Model refs before delegation", async () => {
    const legacyModel = harnessModelRefSchema.parse({ id: "gpt-5.6-luna" });
    const canonicalModel = harnessModelRefSchema.parse({
      id: "codex-model-v1.Z3B0LTUuNi1sdW5h",
    });
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");

    const pending = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      model: legacyModel,
    });
    await answerOfficialParentCwd(fixture);
    const modelList = await readJsonLine(fixture.official.stdin);
    expect(modelList).toMatchObject({ method: "model/list", params: {} });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: modelList.id,
        result: { data: [{ model: "gpt-5.6-luna", isDefault: true }] },
      })}\n`,
    );
    const threadStart = await readJsonLine(fixture.official.stdin);
    expect(threadStart).toMatchObject({
      method: "thread/start",
      params: { model: "gpt-5.6-luna" },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: threadStart.id,
        result: {
          thread: { id: "native-legacy-configured" },
          model: "gpt-5.6-luna",
        },
      })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: { model: "gpt-5.6-luna" },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "native-legacy-turn" } } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({
      configuration: {
        requested: { model: canonicalModel },
        effective: { effectiveModel: canonicalModel },
      },
    });
    await stopFixture(fixture);
  });

  it("delegates to native Codex through brokered official requests without echoing internal responses", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");

    const pending = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      requestId: "native-request-1",
    });
    await answerOfficialParentCwd(fixture);
    const threadStart = await readJsonLine(fixture.official.stdin);
    expect(threadStart).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/synthetic",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: "native-child" } } })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: { threadId: "native-child", input: [{ type: "text", text: "review auth" }] },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "native-turn" } } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({
      threadId: "native-child",
      turnId: "native-turn",
      status: "running",
    });
    expect(
      fixture.collector.messages.some(
        (message) => message.id === threadStart.id || message.id === turnStart.id,
      ),
    ).toBe(false);
    await expect(
      fixture.mappingStore.findDelegationByRequest("native-request-1"),
    ).resolves.toMatchObject({
      childHostThreadId: "native-child",
      targetHarnessId: "codex",
      status: "running",
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "native-child",
          turn: { id: "native-turn", status: "completed" },
        },
      })}\n`,
    );
    await vi.waitFor(async () =>
      expect(await fixture.mappingStore.findDelegationByRequest("native-request-1")).toMatchObject({
        status: "completed",
      }),
    );
    const duplicate = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      requestId: "native-request-1",
    });
    await answerOfficialParentCwd(fixture);
    await expect(duplicate).resolves.toMatchObject({ threadId: "native-child" });
    expect(fixture.official.stdin.readableLength).toBe(0);

    const implicitPending = delegationApi.start({
      harnessId: "codex",
      task: "implicit native task",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    const implicitThreadStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: implicitThreadStart.id, result: { thread: { id: "implicit-child" } } })}\n`,
    );
    const implicitTurnStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: implicitTurnStart.id, result: { turn: { id: "implicit-turn" } } })}\n`,
    );
    await expect(implicitPending).resolves.toMatchObject({ threadId: "implicit-child" });
    const implicitDuplicate = delegationApi.start({
      harnessId: "codex",
      task: "implicit native task",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    await expect(implicitDuplicate).resolves.toMatchObject({ threadId: "implicit-child" });
    expect(fixture.official.stdin.readableLength).toBe(0);
    await stopFixture(fixture);
  });

  it("deletes a native Codex Thread when Delegation persistence fails", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-delegation-write-failure-"));
    const fixture = createFixture({
      mappingStore: new FailingDelegationMappingStore({ directory }),
      mappingStoreDirectory: directory,
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const pending = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    const threadStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: "native-child" } } })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "native-turn" } } })}\n`,
    );
    const deletion = await readJsonLine(fixture.official.stdin);
    expect(deletion).toMatchObject({
      method: "thread/delete",
      params: { threadId: "native-child" },
    });
    fixture.official.stdout.write(`${JSON.stringify({ id: deletion.id, result: {} })}\n`);
    await expect(pending).rejects.toThrow("Synthetic Delegation write failure");
    await stopFixture(fixture);
  });

  it("preserves a terminal native status observed before Delegation persistence", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const pending = delegationApi.start({
      harnessId: "codex",
      task: "fast task",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
      requestId: "fast-native-request",
    });
    await answerOfficialParentCwd(fixture);
    const threadStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: "fast-child" } } })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "fast-child",
          turn: { id: "fast-turn", status: "completed" },
        },
      })}\n`,
    );
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, result: { turn: { id: "fast-turn" } } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    await expect(
      fixture.mappingStore.findDelegationByRequest("fast-native-request"),
    ).resolves.toMatchObject({ status: "completed" });
    await stopFixture(fixture);
  });

  it("proxies native Codex reads into the visible result shape", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    await bindOfficialThread(fixture, "native-child");
    const pending = delegationApi.read({ threadId: "native-child", view: "result" });
    const request = await readJsonLine(fixture.official.stdin);
    expect(request).toMatchObject({
      method: "thread/read",
      params: { threadId: "native-child", includeTurns: true },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        id: request.id,
        result: {
          thread: {
            id: "native-child",
            status: { type: "idle" },
            turns: [
              {
                id: "native-turn",
                status: "completed",
                items: [
                  { id: "reasoning", type: "reasoning", summary: ["hidden"] },
                  { id: "final", type: "agentMessage", phase: "final_answer", text: "done" },
                ],
              },
            ],
          },
        },
      })}\n`,
    );
    const snapshot = await pending;
    expect(snapshot).toMatchObject({
      harnessId: "codex",
      status: "completed",
      result: { availability: "available", text: "done" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("hidden");
    await stopFixture(fixture);
  });

  it("deletes a native Codex Thread when initial task delivery fails", async () => {
    let delegationApi: DelegationControlApi | undefined;
    const fixture = createFixture({
      onDelegationApi: (api) => {
        delegationApi = api;
        return undefined;
      },
    });
    await fixture.ready;
    await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
    if (!delegationApi) throw new Error("Delegation API was not registered");
    const pending = delegationApi.start({
      harnessId: "codex",
      task: "review auth",
      cwd: "/synthetic",
      parentThreadId: "parent-thread",
    });
    await answerOfficialParentCwd(fixture);
    const threadStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: threadStart.id, result: { thread: { id: "native-child" } } })}\n`,
    );
    const turnStart = await readJsonLine(fixture.official.stdin);
    fixture.official.stdout.write(
      `${JSON.stringify({ id: turnStart.id, error: { code: -1, message: "delivery failed" } })}\n`,
    );
    const deletion = await readJsonLine(fixture.official.stdin);
    expect(deletion).toMatchObject({
      method: "thread/delete",
      params: { threadId: "native-child" },
    });
    fixture.official.stdout.write(`${JSON.stringify({ id: deletion.id, result: {} })}\n`);
    await expect(pending).rejects.toThrow("no Turn identity");
    await expect(fixture.mappingStore.listDelegations()).resolves.toHaveLength(0);
    await stopFixture(fixture);
  });

  it("passes Runtime connection and current Thread identity when manually creating an external Thread", async () => {
    class RecordingAdapter extends FakeHarnessAdapter {
      openedInputs: Parameters<FakeHarnessAdapter["open"]>[0][] = [];

      override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
        this.openedInputs.push(input);
        return super.open(input);
      }
    }
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
      },
      externalAdapters: new Map([["pi", adapter]]),
    });
    const threadId = await startPiThread(fixture);
    expect(adapter.openedInputs[0]).toMatchObject({
      environment: {
        CODEXHOST_CLI_PATH: "/opt/codexhost",
        CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
        CODEXHOST_RUNTIME_TOKEN: "token",
        CODEXHOST_THREAD_ID: threadId,
      },
    });
    await stopFixture(fixture);
  });

  it("inspects authoritative external and Codex Thread ownership locally", async () => {
    const fixture = createFixture({
      accountControl: {
        currentAccountId: () => null,
        snapshot: () => ({
          version: 2,
          currentAccountId: null,
          phase: "unavailable",
          revision: 0,
          accounts: [],
        }),
      },
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 40,
      method: "codexhost/thread/inspect",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 40)),
    ).resolves.toMatchObject({
      result: {
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: { id: "fake-model-v1.primary" },
        history: { fork: true, forkAcrossCwd: true, rollbackLastTurn: false },
        locked: true,
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 41,
      method: "codexhost/thread/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 41))).resolves.toEqual({
      id: 41,
      result: { owner: "codex", locked: true },
    });
    writeRequest(fixture.desktopInput, {
      id: 42,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 42))).resolves.toEqual({
      id: 42,
      result: { threadId: "official-thread", usage: null },
    });

    writeRequest(fixture.desktopInput, {
      id: 43,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: 42 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 43)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    // An unavailable current Account must never query native quota.
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("keeps the Host alive when inspecting a Thread without a local Account binding", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    try {
      await bindOfficialThread(fixture, "bound-local-thread");
      writeRequest(fixture.desktopInput, {
        id: 40,
        method: "codexhost/thread/inspect",
        params: { threadId: "remote-thread-without-local-account" },
      });
      await expect(fixture.collector.waitFor((message) => requestId(message, 40))).resolves.toEqual(
        {
          id: 40,
          result: { owner: "codex", locked: true },
        },
      );
      writeRequest(fixture.desktopInput, {
        id: 41,
        method: "codexhost/thread/inspect",
        params: { threadId: "bound-local-thread" },
      });
      await expect(fixture.collector.waitFor((message) => requestId(message, 41))).resolves.toEqual(
        {
          id: 41,
          result: { owner: "codex", locked: true },
        },
      );
      expect(officialWrite).not.toHaveBeenCalled();
    } finally {
      fixture.desktopInput.end();
      await fixture.running;
      rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
    }
  });

  it("projects official Codex token Usage and account rate limits for inspection", async () => {
    const fixture = createFixture();
    fixture.official.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        if (message.method !== "account/rateLimits/read") continue;
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1_800 },
                secondary: { usedPercent: 9, windowDurationMins: 10_080, resetsAt: 2_400 },
              },
              rateLimitsByLimitId: null,
            },
          })}\n`,
        );
      }
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "official-thread",
          turnId: "official-turn",
          tokenUsage: {
            total: {
              totalTokens: 1_000,
              inputTokens: 800,
              cachedInputTokens: 600,
              cacheWriteInputTokens: 10,
              outputTokens: 200,
              reasoningOutputTokens: 50,
            },
            last: {
              totalTokens: 240,
              inputTokens: 200,
              cachedInputTokens: 150,
              cacheWriteInputTokens: 5,
              outputTokens: 40,
              reasoningOutputTokens: 10,
            },
            modelContextWindow: 2_000,
          },
        },
      })}\n`,
    );
    await fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated"));

    writeRequest(fixture.desktopInput, {
      id: 44,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 44))).resolves.toEqual({
      id: 44,
      result: {
        threadId: "official-thread",
        accountCredits: {
          usedPercent: 3,
          periodType: "five_hour",
          resetsAt: new Date(1_800 * 1_000).toISOString(),
          productUsage: [
            {
              product: "7-day window",
              usagePercent: 9,
              resetsAt: new Date(2_400 * 1_000).toISOString(),
            },
          ],
        },
        usage: {
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 600,
          cacheWriteInputTokens: 10,
          outputTokens: 200,
          reasoningOutputTokens: 50,
          contextUsedTokens: 240,
          contextWindowTokens: 2_000,
          cacheHitRatePercent: 75,
        },
      },
    });
    await stopFixture(fixture);
  });

  it("inspects current Account quota and treats other Account ids as unknown", async () => {
    const snapshot = () => ({
      version: 2 as const,
      currentAccountId: "account-a",
      phase: "ready" as const,
      revision: 1,
      accounts: [{ accountId: "account-a", label: "A", email: "a@example.com" }],
    });
    const accountControl: CodexAccountControl = {
      snapshot,
      currentAccountId: () => "account-a",
    };
    const fixture = createFixture({ accountControl });
    fixture.official.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line) continue;
        const message = JSON.parse(line) as JsonObject;
        if (message.method !== "account/rateLimits/read") continue;
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                primary: { usedPercent: 12, windowDurationMins: 300 },
                secondary: { usedPercent: 34, windowDurationMins: 10_080 },
              },
            },
          })}\n`,
        );
      }
    });
    try {
      writeRequest(fixture.desktopInput, {
        id: 46,
        method: "codexhost/account/usage/inspect",
        params: { accountId: "account-b", refresh: true },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 46)),
      ).resolves.toMatchObject({
        id: 46,
        error: { code: -32086, message: "Unknown Codex Account" },
      });

      writeRequest(fixture.desktopInput, {
        id: 47,
        method: "codexhost/account/usage/inspect",
        params: { accountId: "account-a" },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, 47)),
      ).resolves.toMatchObject({
        id: 47,
        result: {
          accountId: "account-a",
          freshness: "live",
          accountCredits: { usedPercent: 12, periodType: "five_hour" },
        },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("keeps cumulative Thread Usage independent from native Account changes", async () => {
    const fixture = createFixture({
      accountControl: {
        currentAccountId: () => null,
        snapshot: () => ({
          version: 2,
          currentAccountId: null,
          phase: "unavailable",
          revision: 0,
          accounts: [],
        }),
      },
    });
    fixture.official.stdout.write(
      `${JSON.stringify({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "official-thread",
          turnId: "official-turn",
          tokenUsage: {
            total: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
            last: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
            modelContextWindow: 1_000,
          },
        },
      })}\n`,
    );
    await fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated"));

    fixture.official.stdout.write(`${JSON.stringify({ method: "account/updated", params: {} })}\n`);
    await fixture.collector.waitFor((message) => method(message, "account/updated"));

    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "codexhost/thread/usage/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 45))).resolves.toEqual({
      id: 45,
      result: {
        threadId: "official-thread",
        usage: {
          totalTokens: 100,
          inputTokens: 80,
          outputTokens: 20,
          contextUsedTokens: 100,
          contextWindowTokens: 1_000,
        },
      },
    });
    await stopFixture(fixture);
  });

  it("continues an existing Pi Thread without requiring a Renderer Model carrier", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const effectiveModel = session.state.effectiveModel;

    writeRequest(fixture.desktopInput, {
      id: 42,
      method: "turn/start",
      params: {
        threadId,
        model: "gpt-5.6-luna",
        input: [{ type: "text", text: "existing Pi turn" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 42)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    expect(session.state.effectiveModel).toEqual(effectiveModel);
    session.succeedTurn();
    await stopFixture(fixture);
  });

  it("lists persisted ownership without restoring external Sessions", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const first = createFixture({
      externalAdapters: new Map([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const piThreadId = await startExternalThread(first, "codexhost/pi-native", 1);
    const claudeThreadId = await startExternalThread(
      first,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      2,
    );
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restartedPi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const restartedClaude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const restarted = createFixture({
      externalAdapters: new Map([
        ["pi", restartedPi],
        ["claude-code", restartedClaude],
      ]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    restarted.official.stdin.on("data", officialWrite);

    writeRequest(restarted.desktopInput, {
      id: 42,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["official-thread", piThreadId, claudeThreadId] },
    });
    await expect(restarted.collector.waitFor((message) => requestId(message, 42))).resolves.toEqual(
      {
        id: 42,
        result: {
          threads: [
            { threadId: "official-thread", owner: "codex" },
            { threadId: piThreadId, owner: "external", harnessId: "pi" },
            { threadId: claudeThreadId, owner: "external", harnessId: "claude-code" },
          ],
        },
      },
    );
    expect(restartedPi.sessions).toHaveLength(0);
    expect(restartedClaude.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(restarted);
  });

  it("rejects invalid or unreadable ownership-list metadata locally", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new FailingOwnershipMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 43,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["duplicate", "duplicate"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 43)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 44,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["unreadable-thread"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 44)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("aggregates official and External Thread rows through an internal official request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const snapshotReads = session.snapshotReads;
    const internalRequest = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(request);
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              data: [{ id: "official-thread", createdAt: 1, updatedAt: 1, recencyAt: 1 }],
              nextCursor: null,
              backwardsCursor: "official-backwards",
            },
          })}\n`,
        );
      });
    });

    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "thread/list",
      params: { limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    await expect(internalRequest).resolves.toMatchObject({
      method: "thread/list",
      params: { cursor: null, limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 45));
    const result = response.result as JsonObject;
    const data = result.data as JsonObject[];
    expect(data.map((thread) => thread.id)).toEqual([threadId, "official-thread"]);
    expect(data[0]).toMatchObject({
      status: { type: "idle" },
      turns: [],
      preview: "",
      isPinned: false,
    });
    expect(session.snapshotReads).toBe(snapshotReads);
    expect(
      fixture.collector.messages.filter(
        (message) => typeof message.id === "string" && message.id.startsWith("codexhost:official:"),
      ),
    ).toEqual([]);
    await stopFixture(fixture);
  });

  it("fails the complete aggregated list when Store or official listing fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const failingStore = new FailingListMappingStore({ directory });
    const storeFailure = createFixture({
      mappingStore: failingStore,
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    storeFailure.official.stdin.on("data", officialWrite);
    writeRequest(storeFailure.desktopInput, { id: 46, method: "thread/list", params: {} });
    await expect(
      storeFailure.collector.waitFor((message) => requestId(message, 46)),
    ).resolves.toMatchObject({ error: { code: -32082 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(storeFailure);

    const officialFailure = createFixture();
    officialFailure.official.stdin.once("data", (chunk: Buffer) => {
      const internal = JSON.parse(chunk.toString("utf8")) as JsonObject;
      officialFailure.official.stdout.write(
        `${JSON.stringify({ id: internal.id, error: { code: -32000, message: "official failed" } })}\n`,
      );
    });
    writeRequest(officialFailure.desktopInput, { id: 47, method: "thread/list", params: {} });
    await expect(
      officialFailure.collector.waitFor((message) => requestId(message, 47)),
    ).resolves.toEqual({ id: 47, error: { code: -32000, message: "official failed" } });
    await stopFixture(officialFailure);
  });

  it("lists an unloaded External Thread after restart without restoring its Adapter", async () => {
    const first = createFixture();
    const threadId = await startPiThread(first);
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restartedAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const restarted = createFixture({
      externalAdapters: new Map([["pi", restartedAdapter]]),
      mappingStoreDirectory: directory,
    });
    restarted.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      restarted.official.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result: { data: [], nextCursor: null, backwardsCursor: null },
        })}\n`,
      );
    });
    writeRequest(restarted.desktopInput, {
      id: 46,
      method: "thread/list",
      params: { limit: 10 },
    });
    const response = await restarted.collector.waitFor((message) => requestId(message, 46));
    const result = response.result as JsonObject;
    expect(result.data).toEqual([
      expect.objectContaining({
        id: threadId,
        status: { type: "notLoaded" },
        canAcceptDirectInput: null,
        turns: [],
      }),
    ]);
    expect(restartedAdapter.sessions).toHaveLength(0);
    await stopFixture(restarted);
  });

  it("forwards a future official Thread list filter unchanged without External injection", async () => {
    const fixture = createFixture();
    const request = {
      id: 47,
      method: "thread/list",
      params: { limit: 3, futureOfficialFilter: { keep: true } },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: 47, result: { data: [], nextCursor: null } })}\n`,
        );
      });
    });
    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 47))).resolves.toEqual({
      id: 47,
      result: { data: [], nextCursor: null },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards section-position Thread lists without External aggregation or Host cursor leakage", async () => {
    const fixture = createFixture();
    await startPiThread(fixture);
    const forward = async (request: JsonObject, response: JsonObject): Promise<void> => {
      writeRequest(fixture.desktopInput, request);
      const officialRequest = await readJsonLine(fixture.official.stdin).catch((error: unknown) => {
        throw new Error(`Timed out forwarding thread/list request ${String(request.id)}`, {
          cause: error,
        });
      });
      expect(officialRequest).toEqual(request);
      fixture.official.stdout.write(`${JSON.stringify({ id: officialRequest.id, ...response })}\n`);
      await expect(
        fixture.collector.waitFor((message) => message.id === request.id),
      ).resolves.toEqual({ id: request.id, ...response });
    };

    await forward(
      {
        id: 52,
        method: "thread/list",
        params: {
          cursor: "official-section-cursor",
          limit: 5,
          sectionId: "section-1",
          sortDirection: "asc",
          sortKey: "section_position",
        },
      },
      {
        result: {
          data: [{ id: "official-second" }, { id: "official-first" }],
          nextCursor: "official-section-next",
          backwardsCursor: "official-section-backwards",
        },
      },
    );
    expect(fixture.collector.messages.find((message) => message.id === 52)?.result).toMatchObject({
      data: [{ id: "official-second" }, { id: "official-first" }],
      nextCursor: "official-section-next",
      backwardsCursor: "official-section-backwards",
    });

    for (const [id, sectionId] of [
      [53, undefined],
      [54, null],
    ] as const) {
      await forward(
        {
          id,
          method: "thread/list",
          params: {
            limit: 5,
            sortDirection: "asc",
            sortKey: "section_position",
            ...(sectionId === undefined ? {} : { sectionId }),
          },
        },
        { error: { code: -32600, message: "sectionId is required" } },
      );
    }

    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 55,
      method: "thread/list",
      params: {
        cursor: "codexhost:thread-list:v1:legacy-host-cursor",
        sectionId: "section-1",
        sortDirection: "asc",
        sortKey: "section_position",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 55)),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("Host cursor") },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("archives and unarchives an active External Thread without closing its Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId, 48);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 49,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 49))).resolves.toEqual({
      id: 49,
      result: {},
    });
    await fixture.collector.waitFor((message) => method(message, "thread/archived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: true, nativeSessionRef: before?.nativeSessionRef });
    const archiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 49,
    );
    const archiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/archived"),
    );
    expect(archiveResponseIndex).toBeLessThan(archiveNotificationIndex);

    session.appendText("still running after archive");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    writeRequest(fixture.desktopInput, {
      id: 50,
      method: "thread/unarchive",
      params: { threadId },
    });
    const unarchive = await fixture.collector.waitFor((message) => requestId(message, 50));
    expect(unarchive).toMatchObject({
      result: { thread: { id: threadId, status: { type: "idle" }, turns: [] } },
    });
    await fixture.collector.waitFor((message) => method(message, "thread/unarchived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false, nativeSessionRef: before?.nativeSessionRef });
    const unarchiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 50,
    );
    const unarchiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/unarchived"),
    );
    expect(unarchiveResponseIndex).toBeLessThan(unarchiveNotificationIndex);
    expect(fixture.adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("does not emit an archive notification when persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new FailingArchiveMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 51)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.collector.messages.some((message) => method(message, "thread/archived"))).toBe(
      false,
    );
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false });
    await stopFixture(fixture);
  });

  it("manages persisted External metadata even when its Harness is not registered", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const seed = new MappingStore({ directory });
    await seed.initialize();
    const threadId = hostThreadIdSchema.parse("unregistered-external");
    await seed.createProvisional({
      hostThreadId: threadId,
      createRequestId: "unregistered-create",
      harnessId: harnessIdSchema.parse("pi"),
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await seed.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: {
        harnessId: harnessIdSchema.parse("pi"),
        nativeSessionId: "unregistered-native",
        formatVersion: 1,
      },
    });
    await seed.close();

    const fixture = createFixture({
      externalAdapters: new Map(),
      mappingStoreDirectory: directory,
    });
    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 52))).resolves.toEqual({
      id: 52,
      result: {},
    });
    await expect(fixture.mappingStore.getThread(threadId)).resolves.toMatchObject({
      archived: true,
    });
    await stopFixture(fixture);
  });

  it("fails External current and future metadata updates closed without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    for (const [id, patch] of [
      [53, { isPinned: true }],
      [54, { gitInfo: { branch: "main", sha: null } }],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/metadata/update",
        params: { threadId, ...patch },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toMatchObject({
        error: { code: -32078, message: "External Thread metadata updates are unsupported" },
      });
    }
    writeRequest(fixture.desktopInput, {
      id: 58,
      method: "thread/future/manage",
      params: { threadId, futureMetadata: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 58)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/future/manage" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(stored).not.toHaveProperty("isPinned");
    expect(stored).not.toHaveProperty("gitInfo");
    await stopFixture(fixture);
  });

  it("forwards official Archive, Unarchive, and metadata updates unchanged", async () => {
    const fixture = createFixture();
    await bindOfficialThread(fixture, "official-thread");
    const officialRequests = new JsonLineCollector(fixture.official.stdin);
    const requests: JsonObject[] = [
      { id: 55, method: "thread/archive", params: { threadId: "official-thread" } },
      { id: 56, method: "thread/unarchive", params: { threadId: "official-thread" } },
      {
        id: 57,
        method: "thread/metadata/update",
        params: { threadId: "official-thread", isPinned: true },
      },
    ];
    for (const request of requests) {
      writeRequest(fixture.desktopInput, request);
      await expect(
        officialRequests.waitFor((message) => message.id === request.id),
      ).resolves.toEqual(request);
      const result = request.id === 55 ? {} : { thread: { id: "official-thread" } };
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      await fixture.collector.waitFor((message) => message.id === request.id);
    }
    const notification = {
      method: "thread/archived",
      params: { threadId: "official-thread" },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/archived")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("preserves the Desktop Thread persistence mode for an external Harness", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        ephemeral: false,
        historyMode: "legacy",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 1)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/started")),
    ).resolves.toMatchObject({
      params: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        ephemeral: true,
        historyMode: "paginated",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: true, historyMode: "paginated", source: "vscode" },
      },
    });
    await stopFixture(fixture);
  });

  it("pages external Turns and Items with paginated resume bootstrap", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        historyMode: "paginated",
      },
    });
    const started = await fixture.collector.waitFor((message) => requestId(message, 10));
    const threadId = ((started.result as JsonObject).thread as JsonObject).id;
    if (typeof threadId !== "string") throw new Error("Paginated Thread has no ID");
    const firstTurnId = await completePiTurn(fixture, threadId, 11);
    const secondTurnId = await completePiTurn(fixture, threadId, 12);
    const thirdTurnId = await completePiTurn(fixture, threadId, 13);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Paginated Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 14,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 14)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 15,
      method: "thread/turns/list",
      params: { threadId, limit: 2, itemsView: "summary" },
    });
    const turnsPage = await fixture.collector.waitFor((message) => requestId(message, 15));
    expect(turnsPage).toMatchObject({
      result: {
        data: [
          {
            id: thirdTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
          {
            id: secondTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
        ],
        nextCursor: expect.any(String),
        backwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 16,
      method: "thread/items/list",
      params: { threadId, turnId: thirdTurnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 16)),
    ).resolves.toMatchObject({
      result: {
        data: [
          { turnId: thirdTurnId, item: { type: "userMessage" } },
          { turnId: thirdTurnId, item: { type: "agentMessage" } },
        ],
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 17,
      method: "thread/resume",
      params: {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, itemsView: "summary" },
      },
    });
    const resumed = await fixture.collector.waitFor((message) => requestId(message, 17));
    expect(resumed).toMatchObject({
      result: {
        thread: { id: threadId, turns: [] },
        initialTurnsPage: { data: [{ id: thirdTurnId }] },
        turnsBackwardsCursor: expect.any(String),
        itemsBackwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(2);

    const itemsBackwardsCursor = (resumed.result as JsonObject).itemsBackwardsCursor;
    if (typeof itemsBackwardsCursor !== "string") {
      throw new Error("Paginated resume did not return an Item head cursor");
    }
    writeRequest(fixture.desktopInput, {
      id: 18,
      method: "thread/items/list",
      params: {
        threadId,
        turnId: firstTurnId,
        cursor: itemsBackwardsCursor,
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 18)),
    ).resolves.toMatchObject({
      result: { data: [], nextCursor: null, backwardsCursor: null },
    });

    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("selects an existing Pi Thread Model from ordered Session state", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 31,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 31)),
    ).resolves.toMatchObject({
      id: 31,
      result: {
        effectiveModel: model,
        effectiveThinkingOptionId: "off",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
        ],
      },
    });
    expect(fixture.adapter.sessions[0]?.state.effectiveModel).toEqual(model);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });
});
