import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { hostThreadIdSchema } from "@codexhost/shared-contracts";
import { ClientChannelHost } from "../src/client-channel-host.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";
import { encodeOfficialCodexModelRef } from "../src/official-codex-model-ref.js";
import { createFixture, startPiThread, stopFixture } from "./app-server-host-fixture.js";

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
    "codexhost/thread/queue/send-now",
  ]) {
    request.mockClear();
    submit.mockClear();
    const params = { threadId: "official", queuedSubmissionId: "queued" };
    await host.handleClientRequest(method, params);
    expect(request).toHaveBeenLastCalledWith(
      method === "codexhost/thread/queue/send-now" ? "thread/queue/start" : method,
      params,
    );
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
    "codexhost/thread/inspect",
  ]) {
    request.mockClear();
    submit.mockClear();
    for (const threadId of ["official", external]) {
      await host.handleClientRequest(method, { threadId });
      expect(submit).toHaveBeenLastCalledWith(method, { threadId }, undefined);
    }
    expect(request).not.toHaveBeenCalled();
  }
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
    cwd: expect.stringContaining(path.join(home, "Documents", "Codex")),
  });
  expect(await fixture.mappingStore.listThreads()).toHaveLength(1);
});

it("uses official profiles and waits for settings confirmation; forwards commands and lists enabled Skills", async () => {
  const fixture = createFixture();
  cleanup.push(() => stopFixture(fixture));
  await fixture.ready;
  let settings: JsonObject = {
    model: "old",
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
            { model: "old", displayName: "Old", isDefault: true, supportedReasoningEfforts: [] },
          ],
        };
      if (method === "permissionProfile/list")
        result = {
          data: [
            { id: ":workspace", description: "Workspace", allowed: true },
            { id: "custom-profile", description: "Custom", allowed: true },
            { id: ":danger-full-access", allowed: false },
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
                { name: "build", description: "Build it", enabled: true },
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
      permissionModes: { modes: [{ id: ":workspace" }, { id: "custom-profile" }] },
      capabilities: { configuration: { selectPermissionMode: true } },
    },
  });
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
    const before = await fixture.host.handleClientRequest("codexhost/thread/inspect", {
      threadId: "official",
    });
    expect(before).toMatchObject({
      result: {
        effectiveModel: encodeOfficialCodexModelRef(String(settings.model)),
        effectivePermissionModeId: (settings.activePermissionProfile as JsonObject).id,
      },
    });
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
});
