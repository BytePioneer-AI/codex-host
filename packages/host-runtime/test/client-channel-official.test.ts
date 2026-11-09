import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { ClientChannelHost } from "../src/client-channel-host.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { encodeOfficialCodexModelRef } from "../src/official-codex-model-ref.js";
import {
  createFixture,
  startPiThread,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";
import type {
  NativeClientChannelDependencies,
  NativeClientReply,
} from "../src/native-client-channel.js";
import { OfficialRuntimeClient } from "../src/codex-runtime/official-runtime-scope.js";
import { OfficialAdmissionError } from "../src/codex-runtime/official-work-gate.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("routes official and external queue, configuration, command, pin and usage methods by owner", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  const external = await startPiThread(fixture);
  const record = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(external));
  if (!record) throw new Error("Missing fixture Thread");
  const home = mkdtempSync(path.join(tmpdir(), "official-create-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const request = vi.fn(async () => ({ result: {} }));
  const submit = vi.fn(async () => ({ result: {} }));
  const events = new ClientChannelEvents();
  const host = new ClientChannelHost({
    events,
    environment: () => ({ HOME: home, USERPROFILE: home }),
    waitForPlugins: async () => {},
    listRecords: async () => [],
    listSectionPlacements: async () => [],
    locateExternalThread: async (id) =>
      id === external ? { kind: "external", record, thread: null } : { kind: "official" },
    loadedThread: () => undefined,
    clientHistoryTurns: () => [],
    queueSnapshot: () => ({ items: [], pausedReason: null }),
    interactions: {
      approvals: new Map(),
      questions: new Map(),
      isApprovalRequestId: (value): value is number => typeof value === "number",
      isQuestionRequestId: (value): value is number => typeof value === "number",
      respondApproval: async () => false,
      respondQuestion: async () => false,
    },
    native: { events, request, respond: async () => {} },
    submit,
  });
  for (const method of [
    "thread/queue/list",
    "thread/queue/add",
    "thread/queue/update",
    "thread/queue/delete",
    "thread/queue/reorder",
    "thread/queue/start",
  ]) {
    request.mockClear();
    submit.mockClear();
    const params = { threadId: "official", queuedSubmissionId: "queued" };
    await host.handleClientRequest(method, params);
    expect(request).toHaveBeenLastCalledWith(method, params);
    expect(submit).not.toHaveBeenCalled();
    await host.handleClientRequest(method, { ...params, threadId: external });
    expect(submit).toHaveBeenLastCalledWith(method, { ...params, threadId: external }, undefined);
  }
  for (const method of [
    "codexhost/thread/model/select",
    "codexhost/thread/thinking/select",
    "codexhost/thread/permission-mode/select",
    "codexhost/thread/commands/inspect",
    "codexhost/thread/command/execute",
    "codexhost/thread/pins/set",
    "codexhost/thread/usage/inspect",
  ]) {
    request.mockClear();
    submit.mockClear();
    for (const threadId of ["official", external]) {
      await host.handleClientRequest(method, { threadId });
      expect(submit).toHaveBeenLastCalledWith(method, { threadId }, undefined);
    }
    expect(request).not.toHaveBeenCalled();
  }
  request.mockClear();
  submit.mockClear();
  await host.handleClientRequest("codexhost/thread/queue/send-now", {
    threadId: "official",
    itemId: "second-queued",
  });
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/queue/start", {
    threadId: "official",
    queuedSubmissionId: "second-queued",
  });
  expect(submit).not.toHaveBeenCalled();
  await host.handleClientRequest("codexhost/thread/queue/send-now", {
    threadId: external,
    itemId: "external-queued",
  });
  expect(submit).toHaveBeenLastCalledWith(
    "codexhost/thread/queue/send-now",
    { threadId: external, itemId: "external-queued" },
    undefined,
  );
  request.mockClear();
  submit.mockClear();
  expect(
    await host.handleClientRequest("codexhost/thread/inspect", { threadId: "official" }),
  ).toMatchObject({ result: { owner: "codex", locked: false } });
  expect(request).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await host.handleClientRequest("codexhost/thread/inspect", { threadId: external });
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    "codexhost/thread/inspect",
    { threadId: external },
    undefined,
  );
  await host.handleClientRequest("turn/start", {
    threadId: "official",
    delivery: "queue",
    input: [],
  });
  expect(request).toHaveBeenLastCalledWith(
    "thread/queue/add",
    expect.objectContaining({ threadId: "official" }),
  );
  await host.handleClientRequest("thread/start", {
    model: encodeOfficialCodexModelRef("gpt/test"),
    projectlessWorkspace: { prompt: "a new task" },
  });
  expect(request).toHaveBeenLastCalledWith("thread/start", {
    model: "gpt/test",
    serviceTier: null,
    cwd: expect.stringContaining(path.join(home, "Documents", "Codex")),
  });
  await host.handleClientRequest("thread/start", {
    model: encodeOfficialCodexModelRef("gpt/test", "priority"),
    cwd: "/workspace",
  });
  expect(request).toHaveBeenLastCalledWith("thread/start", {
    model: "gpt/test",
    serviceTier: "priority",
    cwd: "/workspace",
  });
  await host.handleClientRequest("thread/start", { cwd: "/workspace" });
  expect(request).toHaveBeenLastCalledWith("thread/start", { cwd: "/workspace" });
  expect(await fixture.mappingStore.listThreads()).toHaveLength(1);
});

it("uses official profiles and waits for settings confirmation; forwards commands and lists enabled Skills", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  let settings: JsonObject = {
    model: "old",
    serviceTier: null,
    effort: "low",
    activePermissionProfile: { id: ":workspace" },
  };
  const updates: JsonObject[] = [];
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as JsonObject;
      buffer = buffer.slice(end + 1);
      const method = String(request.method),
        params = (request.params ?? {}) as JsonObject;
      calls.push({ method, params });
      let result: JsonObject = {};
      if (method === "model/list")
        result = {
          data: [
            {
              model: "old",
              displayName: "Old",
              isDefault: true,
              supportedReasoningEfforts: [
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra",
                "future-effort",
              ].map((reasoningEffort) => ({
                reasoningEffort,
                description: "Fast responses with lighter reasoning",
              })),
            },
          ],
        };
      if (method === "permissionProfile/list")
        result = {
          data: [
            { id: ":workspace", description: "Workspace", allowed: true },
            { id: ":read-only", description: "Read without writing files", allowed: true },
            { id: ":danger-full-access", description: "Unrestricted access", allowed: true },
            { id: ":future-profile", description: "Future", allowed: true },
            { id: "custom-profile", description: "Custom", allowed: true },
            { id: ":blocked-profile", allowed: false },
          ],
          nextCursor: null,
        };
      if (method === "thread/resume")
        result = { ...settings, reasoningEffort: settings.effort ?? null };
      if (method === "thread/settings/update") updates.push(params);
      if (method === "thread/read") result = { thread: { id: "official", cwd: "/workspace" } };
      if (method === "skills/list")
        result = {
          data: [
            {
              cwd: "/workspace",
              skills: [
                {
                  name: "build",
                  description: "Build it",
                  path: "/workspace/.agents/skills/build/SKILL.md",
                  enabled: true,
                },
                { name: "hidden", enabled: false },
              ],
            },
          ],
        };
      if (method === "review/start") result = { turn: { id: "review-turn" } };
      if (request.id !== undefined)
        fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  const inspection = await fixture.host.handleClientRequest("codexhost/harness/inspect", {
    harnessId: "codex",
  });
  expect(inspection).toMatchObject({
    result: {
      status: "ready",
      permissionModes: {
        modes: [
          { id: ":workspace", label: "Workspace write", description: "Workspace" },
          { id: ":read-only", label: "Read only", description: "Read without writing files" },
          { id: ":danger-full-access", label: "Full access", description: "Unrestricted access" },
          { id: ":future-profile", label: "future-profile", description: "Future" },
          { id: "custom-profile", label: "custom-profile", description: "Custom" },
        ],
      },
      capabilities: { configuration: { selectPermissionMode: true } },
    },
  });
  expect(inspection).toHaveProperty("result.catalog.thinkingOptions", [
    { id: "none", label: "None" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
    { id: "max", label: "Max" },
    { id: "ultra", label: "Ultra" },
    { id: "future-effort", label: "future-effort" },
  ]);
  writeRequest(fixture.desktopInput, {
    id: 1001,
    method: "codexhost/thread/inspect",
    params: { threadId: "official" },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 1001)).toMatchObject({
    result: { owner: "codex", locked: true },
  });
  expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  for (const [method, selection, applied] of [
    ["model", { model: encodeOfficialCodexModelRef("new") }, { model: "new" }],
    ["thinking", { thinkingOptionId: "high" }, { effort: "high" }],
    [
      "permission-mode",
      { permissionModeId: "custom-profile" },
      { activePermissionProfile: { id: "custom-profile" } },
    ],
  ] as const) {
    let resolved = false;
    const selectionResult = fixture.host
      .handleClientRequest(`codexhost/thread/${method}/select`, {
        threadId: "official",
        ...selection,
      })
      .then((reply) => {
        resolved = true;
        return reply;
      });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    updates.shift();
    expect(resolved).toBe(false);
    settings = { ...settings, ...applied };
    fixture.official.stdout.write(
      `${JSON.stringify({ method: "thread/settings/updated", params: { threadId: "official", threadSettings: settings } })}\n`,
    );
    expect(await selectionResult).toMatchObject({
      result: {
        effectiveModel: encodeOfficialCodexModelRef(String(settings.model)),
        effectiveThinkingOptionId: settings.effort,
        effectivePermissionModeId: (settings.activePermissionProfile as JsonObject).id,
      },
    });
  }
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/commands/inspect", {
      threadId: "official",
    }),
  ).toMatchObject({
    result: {
      commands: [
        { id: "compact", invocation: "/compact" },
        { id: "review", invocation: "/review" },
        { id: "skill:build", invocation: "$build", kind: "skill" },
      ],
    },
  });
  writeRequest(fixture.desktopInput, {
    id: 1002,
    method: "codexhost/thread/commands/inspect",
    params: { threadId: "official" },
  });
  expect(await fixture.collector.waitFor((message) => message.id === 1002)).toMatchObject({
    result: { commands: [] },
  });
  expect(calls.filter((call) => call.method === "skills/list")).toHaveLength(1);
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/command/execute", {
      threadId: "official",
      commandId: "compact",
    }),
  ).toEqual({ result: { accepted: true } });
  expect(calls).toContainEqual({
    method: "thread/compact/start",
    params: { threadId: "official" },
  });
  expect(
    await fixture.host.handleClientRequest("codexhost/thread/command/execute", {
      threadId: "official",
      commandId: "review",
      arguments: { text: "check tests" },
    }),
  ).toMatchObject({ result: { accepted: true, turnId: "review-turn" } });
  expect(calls).toContainEqual({
    method: "review/start",
    params: {
      threadId: "official",
      target: { type: "custom", instructions: "check tests" },
      delivery: "inline",
    },
  });
  expect(calls).toContainEqual({ method: "skills/list", params: { cwds: ["/workspace"] } });
  expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(5);
  expect(
    calls
      .filter((call) => call.method === "thread/resume")
      .every((call) => call.params.excludeTurns === true),
  ).toBe(true);
});

it("keeps writer-conflicted snapshots readable and falls back to queue IDs for missing client message IDs", async () => {
  const events = new ClientChannelEvents();
  const thread = {
    id: "official",
    cwd: "/workspace",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    turns: [],
  };
  let occupied = true;
  const request = vi.fn<NativeClientChannelDependencies["request"]>(
    async (method): Promise<NativeClientReply> => {
      if (method === "thread/resume")
        return occupied
          ? { error: { code: -32600, message: "thread official already has an active writer" } }
          : {
              result: {
                thread,
                model: "gpt-5.4",
                reasoningEffort: "high",
                activePermissionProfile: { id: ":workspace" },
              },
            };
      if (method === "thread/read") return { result: { thread } };
      if (method === "thread/turns/list") return { result: { data: [], nextCursor: null } };
      if (method === "thread/queue/list")
        return {
          result: {
            data: [
              { id: "missing-client-id", input: [] },
              { id: "with-client-id", input: [], clientUserMessageId: "original-client-id" },
            ],
          },
        };
      throw new Error(`Unexpected native method ${method}`);
    },
  );
  const submit = vi.fn(async () => {
    throw new Error("Snapshots must not call Host inspect");
  });
  const host = new ClientChannelHost({
    events,
    environment: () => ({}),
    waitForPlugins: async () => {},
    listRecords: async () => [],
    listSectionPlacements: async () => [],
    locateExternalThread: async () => ({ kind: "official" }),
    loadedThread: () => undefined,
    clientHistoryTurns: () => [],
    queueSnapshot: () => ({ items: [], pausedReason: null }),
    interactions: {
      approvals: new Map(),
      questions: new Map(),
      isApprovalRequestId: (value): value is number => typeof value === "number",
      isQuestionRequestId: (value): value is number => typeof value === "number",
      respondApproval: async () => false,
      respondQuestion: async () => false,
    },
    native: { events, request, respond: async () => {} },
    submit,
  });
  const readOnly = await host.clientSnapshot("official");
  expect(readOnly.thread.nativeSendError).toContain("请先在另一端关闭此会话");
  expect(readOnly.queue).toEqual({ items: [], pausedReason: null });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "thread/resume",
    "thread/read",
    "thread/turns/list",
  ]);
  occupied = false;
  const writable = await host.clientSnapshot("official");
  expect(writable.thread.nativeSendError).toBeUndefined();
  expect(writable.queue?.items).toEqual([
    { id: "missing-client-id", input: [], clientUserMessageId: "missing-client-id" },
    { id: "with-client-id", input: [], clientUserMessageId: "original-client-id" },
  ]);
  expect(writable.configuration).toMatchObject({
    effectiveModel: encodeOfficialCodexModelRef("gpt-5.4"),
    effectiveThinkingOptionId: "high",
    effectivePermissionModeId: ":workspace",
  });
  expect(submit).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith("thread/resume", {
    threadId: "official",
    excludeTurns: true,
  });
});

it("pairs official Web submissions with their snapshot user Items before fingerprinting", async () => {
  const events = new ClientChannelEvents();
  const turns: JsonObject[] = [];
  const thread = {
    id: "official",
    cwd: "/workspace",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    turns: [],
  };
  const request: NativeClientChannelDependencies["request"] = async (method, params) => {
    if (method === "thread/resume" || method === "thread/read") return { result: { thread } };
    if (method === "thread/queue/list") return { result: { data: [] } };
    if (method === "thread/turns/list")
      return { result: { data: structuredClone([...turns].reverse()), nextCursor: null } };
    if (method === "turn/start") {
      const id = `turn-${turns.length + 1}`;
      // Official history does not echo the Web's clientUserMessageId.
      turns.push({
        id,
        status: "completed",
        items: [{ id: `${id}-user`, type: "userMessage", content: params.input ?? [] }],
      });
      return { result: { turn: { id, status: "inProgress", items: [] } } };
    }
    throw new Error(`Unexpected native method ${method}`);
  };
  const host = new ClientChannelHost({
    events,
    environment: () => ({}),
    waitForPlugins: async () => {},
    listRecords: async () => [],
    listSectionPlacements: async () => [],
    locateExternalThread: async () => ({ kind: "official" }),
    loadedThread: () => undefined,
    clientHistoryTurns: () => [],
    queueSnapshot: () => ({ items: [], pausedReason: null }),
    interactions: {
      approvals: new Map(),
      questions: new Map(),
      isApprovalRequestId: (value): value is number => typeof value === "number",
      isQuestionRequestId: (value): value is number => typeof value === "number",
      respondApproval: async () => false,
      respondQuestion: async () => false,
    },
    native: { events, request, respond: async () => {} },
    submit: async () => {
      throw new Error("Must use the official client");
    },
  });
  for (const [index, text] of ["你好", "你在做是什么"].entries()) {
    expect(
      await host.handleClientRequest("turn/start", {
        threadId: thread.id,
        clientUserMessageId: `web-${index + 1}`,
        input: [{ type: "text", text }],
      }),
    ).toHaveProperty("result");
  }
  const snapshot = await host.clientSnapshot(thread.id, { knownTurns: [] });
  expect(snapshot.turnsPage.data.map((turn) => turn.items[0]?.clientId)).toEqual([
    "web-2",
    "web-1",
  ]);
  expect(snapshot.activeTurnId).toBeUndefined();
  const knownTurns = snapshot.turnsPage.data.map((turn) => ({
    id: String(turn.id),
    fingerprint: String(turn.fingerprint),
  }));
  const compacted = await host.clientSnapshot(thread.id, { knownTurns });
  expect(compacted.turnsPage.data.every((turn) => turn.unchanged === true)).toBe(true);
});

it("only reports official admission failures as notInstalled and preserves other inspection errors", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  const request = vi
    .spyOn(OfficialRuntimeClient.prototype, "request")
    .mockRejectedValueOnce(new OfficialAdmissionError("unavailable"))
    .mockRejectedValueOnce(new Error("catalog query failed"));
  cleanup.push(() => request.mockRestore());
  expect(
    await fixture.host.handleClientRequest("codexhost/harness/inspect", { harnessId: "codex" }),
  ).toMatchObject({ result: { status: "notInstalled" } });
  expect(
    await fixture.host.handleClientRequest("codexhost/harness/inspect", { harnessId: "codex" }),
  ).toMatchObject({ result: { status: "error", error: { message: "catalog query failed" } } });
});
