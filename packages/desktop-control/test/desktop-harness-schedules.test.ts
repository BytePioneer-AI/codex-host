import { describe, expect, it, vi } from "vitest";
import {
  decodeHarnessPluginRoute,
  harnessScheduleInputSchema,
  harnessInspectionSchema,
  threadInspectionSchema,
} from "@codexhost/shared-contracts";
import {
  createDesktopHarnessScheduleSession,
  DesktopScheduleRejectedError,
  scheduleRrule,
} from "../src/desktop-harness-schedule-creation.js";
import {
  bindReviewedDesktopScheduleServices,
  resolveDesktopScheduleScope,
} from "../src/desktop-harness-schedules.js";
import type { RendererHostRouting } from "../src/renderer-host-routing.js";

const input = harnessScheduleInputSchema.parse({
  harnessId: "pi",
  model: { id: "test-model" },
  prompt: "Harmless test",
  frequency: "daily",
  hour: 9,
  minute: 15,
  weekday: 1,
});
const threadId = "ffb4571e-d945-4f3e-8ce4-1db511796000";
const inspection = harnessInspectionSchema.parse({
  status: "ready",
  catalog: { models: [{ ref: input.model, label: "Test Model" }], thinkingOptions: [] },
  capabilities: {
    configuration: {
      selectModel: true,
      selectThinkingOption: false,
      selectPermissionMode: false,
      permissionModeScope: "live",
    },
    history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
  },
});
const ownership = threadInspectionSchema.parse({
  owner: "external",
  harnessId: "pi",
  transportModelId: "codexhost/pi-native",
  effectiveModel: input.model,
  locked: true,
  history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
});
function fixture() {
  const services = {
    assertAvailable: vi.fn(),
    inspect: vi.fn(async () => inspection),
    allocate: vi.fn(async () => ({
      cwd: "/custom-root/date/chat",
      workspaceRoot: "/custom-root/date/chat",
    })),
    validateDirectory: vi.fn(async () => {}),
    createThread: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
      status: "created",
      conversationId: threadId,
      firstTurn: { status: "not-requested" },
    })),
    inspectThread: vi.fn(async () => ownership),
    isThreadReady: vi.fn(() => true),
    save: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
      item: { id: "schedule", kind: "heartbeat", targetThreadId: threadId },
    })),
    refreshList: vi.fn(async () => {}),
  };
  return {
    services,
    session: createDesktopHarnessScheduleSession(services),
    signal: new AbortController().signal,
  };
}
describe("fixed chat schedule creation", () => {
  it.each(
    (["save", "createThread", "allocate"] as const).flatMap((method) =>
      [-32603, -32000].map((jsonRpcCode) => ({ method, jsonRpcCode })),
    ),
  )(
    "does not replay $method after numeric RPC error $jsonRpcCode",
    async ({ method, jsonRpcCode }) => {
      const f = fixture();
      f.services[method].mockRejectedValueOnce(
        Object.assign(new Error("internal failure after commit"), { jsonRpcCode }),
      );
      const first = await f.session.submit(input, f.signal);
      expect(first).toMatchObject({ outcome: "unknown", retryable: false });
      if (method === "save") expect(first.threadId).toBe(threadId);
      expect(await f.session.submit(input, f.signal)).toEqual(first);
      expect(f.services.allocate).toHaveBeenCalledOnce();
      expect(f.services.createThread).toHaveBeenCalledTimes(method === "allocate" ? 0 : 1);
      expect(f.services.save).toHaveBeenCalledTimes(method === "save" ? 1 : 0);
    },
  );
  it("never retries a saved schedule when the official list refresh fails", async () => {
    const f = fixture();
    f.services.refreshList.mockRejectedValueOnce(new DesktopScheduleRejectedError("read failed"));
    expect(await f.session.submit(input, f.signal)).toMatchObject({
      outcome: "unknown",
      retryable: false,
    });
    await f.session.submit(input, f.signal);
    expect(f.services.save).toHaveBeenCalledOnce();
  });
  it("does not retry an unconfirmed allocated workspace", async () => {
    const f = fixture();
    f.services.allocate.mockResolvedValueOnce({ cwd: "", workspaceRoot: "" });
    expect((await f.session.submit(input, f.signal)).outcome).toBe("unknown");
    await f.session.submit(input, f.signal);
    expect(f.services.allocate).toHaveBeenCalledOnce();
    expect(f.services.createThread).not.toHaveBeenCalled();
  });
  it("does not bypass incomplete empty-chat initialization on retry", async () => {
    const f = fixture();
    f.services.createThread.mockResolvedValueOnce({
      status: "created",
      conversationId: threadId,
      firstTurn: { status: "not-started" },
    });
    expect(await f.session.submit(input, f.signal)).toMatchObject({
      outcome: "failed",
      retryable: false,
      threadId,
    });
    await f.session.submit(input, f.signal);
    expect(f.services.createThread).toHaveBeenCalledOnce();
    expect(f.services.save).not.toHaveBeenCalled();
  });
  it("uses the allocated persistent workspace, explicit Model, and a model-free heartbeat", async () => {
    const f = fixture();
    const result = await f.session.submit(input, f.signal);
    expect(result).toMatchObject({ outcome: "saved", threadId, cwd: "/custom-root/date/chat" });
    expect(f.services.allocate).toHaveBeenCalledWith("Harmless test");
    const created = f.services.createThread.mock.calls[0]?.[0] as {
      model: string;
      cwd: string;
      projectless: boolean;
    };
    expect(decodeHarnessPluginRoute(created.model)).toEqual({
      harnessId: "pi",
      model: input.model,
    });
    expect(created).toMatchObject({ cwd: result.cwd, projectless: true });
    expect(f.services.save).toHaveBeenCalledExactlyOnceWith({
      kind: "heartbeat",
      name: input.prompt,
      prompt: input.prompt,
      status: "ACTIVE",
      targetThreadId: threadId,
      model: null,
      reasoningEffort: null,
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=15;BYSECOND=0",
    });
    expect(f.services.refreshList).toHaveBeenCalledOnce();
    await f.session.submit(input, f.signal);
    expect(f.services.save).toHaveBeenCalledOnce();
  });
  it("validates an explicit directory without allocating one", async () => {
    const f = fixture();
    await f.session.submit({ ...input, cwd: "/explicit" }, f.signal);
    expect(f.services.allocate).not.toHaveBeenCalled();
    expect(f.services.validateDirectory).toHaveBeenCalledWith("/explicit");
    expect(f.services.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/explicit", projectless: false }),
    );
  });
  it.each(["allocate", "validateDirectory", "createThread"] as const)(
    "does not save when %s fails",
    async (method) => {
      const f = fixture();
      f.services[method].mockRejectedValueOnce(new DesktopScheduleRejectedError("rejected"));
      expect((await f.session.submit(input, f.signal)).outcome).toBe("failed");
      expect(f.services.save).not.toHaveBeenCalled();
    },
  );
  it("does not start a Thread for an obsolete Model or invalid fields", async () => {
    const f = fixture();
    await f.session.submit({ ...input, model: { id: "gone" } as typeof input.model }, f.signal);
    await f.session.submit({ ...input, hour: 24 }, f.signal);
    expect(f.services.allocate).not.toHaveBeenCalled();
    expect(f.services.createThread).not.toHaveBeenCalled();
  });
  it("keeps the confirmed Thread for an explicit pre-write schedule rejection", async () => {
    const f = fixture();
    f.services.save.mockRejectedValueOnce(
      new DesktopScheduleRejectedError("thread verification unavailable"),
    );
    expect(await f.session.submit(input, f.signal)).toMatchObject({
      outcome: "failed",
      retryable: true,
      threadId,
    });
    expect(await f.session.submit(input, f.signal)).toMatchObject({ outcome: "saved", threadId });
    expect(f.services.createThread).toHaveBeenCalledOnce();
    expect(f.services.allocate).toHaveBeenCalledOnce();
    expect(f.services.save).toHaveBeenCalledTimes(2);
    for (const [saved] of f.services.save.mock.calls)
      expect(saved).toMatchObject({ targetThreadId: threadId });
  });
  it("does not save a Host-only or wrongly owned Thread", async () => {
    const f = fixture();
    f.services.isThreadReady.mockReturnValueOnce(false);
    expect(await f.session.submit(input, f.signal)).toMatchObject({ outcome: "failed", threadId });
    expect(f.services.save).not.toHaveBeenCalled();
    f.services.inspectThread.mockResolvedValueOnce({ owner: "codex", locked: true });
    expect((await f.session.submit(input, f.signal)).outcome).toBe("failed");
    expect(f.services.createThread).toHaveBeenCalledOnce();
  });
  it("deduplicates double submit and never replays an unknown save result", async () => {
    const f = fixture();
    const saved = Promise.withResolvers<unknown>();
    f.services.save.mockReturnValueOnce(saved.promise);
    const first = f.session.submit(input, f.signal);
    expect(f.session.submit(input, f.signal)).toBe(first);
    await vi.waitFor(() => expect(f.services.save).toHaveBeenCalledOnce());
    saved.reject(new Error("connection closed after dispatch"));
    expect(await first).toMatchObject({ outcome: "unknown", retryable: false, threadId });
    await f.session.submit(input, f.signal);
    expect(f.services.save).toHaveBeenCalledOnce();
    expect(f.services.createThread).toHaveBeenCalledOnce();
  });
  it("does not replay a timed-out create or continue saving after page cancellation", async () => {
    const f = fixture();
    const created = Promise.withResolvers<unknown>();
    f.services.createThread.mockReturnValue(created.promise);
    const controller = new AbortController();
    const first = f.session.submit(input, controller.signal);
    await vi.waitFor(() => expect(f.services.createThread).toHaveBeenCalledOnce());
    controller.abort();
    expect((await first).outcome).toBe("unknown");
    created.resolve({
      status: "created",
      conversationId: threadId,
      firstTurn: { status: "not-requested" },
    });
    await Promise.resolve();
    await Promise.resolve();
    await f.session.submit(input, f.signal);
    expect(f.services.createThread).toHaveBeenCalledOnce();
    expect(f.services.save).not.toHaveBeenCalled();
  });
  it("bounds an unresponsive write without automatically retrying", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.services.save.mockReturnValue(new Promise(() => {}));
      const session = createDesktopHarnessScheduleSession(f.services, 50);
      const pending = session.submit(input, f.signal);
      await vi.advanceTimersByTimeAsync(50);
      expect((await pending).outcome).toBe("unknown");
      await session.submit(input, f.signal);
      expect(f.services.save).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("formats only daily and weekly local calendar schedules", () => {
    expect(scheduleRrule({ ...input, frequency: "weekly", weekday: 5 })).toBe(
      "FREQ=WEEKLY;BYHOUR=9;BYMINUTE=15;BYSECOND=0;BYDAY=FR",
    );
  });
});

function nativeFixture() {
  const readInputs = vi.fn();
  const manager = {
    requestClient: {},
    getHostId: () => "local",
    createProjectlessThreadWorkspace: vi.fn(async () => ({
      cwd: "/configured-root/day/name",
      workspaceRoot: "/configured-root/day/name",
    })),
    startConversation: vi.fn(async () => ({})),
    sendRequest: vi.fn<(method: string, input: unknown) => Promise<unknown>>(async () => ({
      entries: [],
    })),
    getConversation: vi.fn<() => unknown>(() => ({
      resumeState: "resumed",
      mode: "default",
      turns: [],
      requests: [],
      currentPermissions: { approvalPolicy: "on-request" },
      latestCollaborationMode: { mode: "default", settings: { model: "codexhost/pi-native" } },
    })),
  };
  const scope = { get: vi.fn(), queryClient: { invalidateQueries: vi.fn(async () => {}) } };
  const route = {
    hostId: "local",
    manager,
    policy: {
      scopedCreation: true,
      createScheduledConversation: vi.fn(async (input: unknown, read: unknown) => ({
        input,
        read,
      })),
    },
  };
  const routing = { forHost: vi.fn(() => route) } as unknown as RendererHostRouting;
  const native = {
    isPrimaryWindow: true,
    localAutomations: Object.assign(() => {}, {
      create: vi.fn(async () => ({
        item: { id: "new", kind: "heartbeat", targetThreadId: threadId },
      })),
      list: vi.fn<() => unknown>(async () => ({ items: [] })),
      update: vi.fn(),
      delete: vi.fn(),
    }),
  };
  const reader = {
    params: { scope, hostId: "local", requestClient: manager.requestClient },
    readCreationInputs: readInputs,
    readPrewarmInputs: vi.fn(),
    readInputs: vi.fn(),
  };
  const factory = vi.fn((): unknown => reader);
  const bind = () => bindReviewedDesktopScheduleServices(native, scope, routing, factory);
  return { native, scope, route, routing, manager, reader, factory, readInputs, bind };
}
describe("reviewed Desktop 26.1021 services", () => {
  it("accepts the callable native RPC namespaces observed in the running Desktop", () => {
    const f = nativeFixture();
    expect(f.bind().creationUnavailableReason).toBeNull();
  });
  it("binds list/update/delete to the same native service and reads persisted ownership", async () => {
    const f = nativeFixture(),
      service = f.bind(),
      native = f.native.localAutomations;
    expect(await service.listAutomations()).toEqual({ items: [] });
    f.manager.sendRequest.mockResolvedValueOnce({
      threads: [{ threadId, owner: "external", harnessId: "pi" }],
    });
    expect(await service.readOwnership(threadId)).toMatchObject({
      threadId,
      owner: "external",
      harnessId: "pi",
    });
    expect(f.manager.sendRequest).toHaveBeenCalledExactlyOnceWith(
      "codexhost/thread/ownership/list",
      { threadIds: [threadId] },
    );
    const update = { id: "existing", kind: "heartbeat", targetThreadId: threadId, name: "changed" };
    await service.updateAutomation(update);
    await service.deleteAutomation("existing");
    expect(native.list).toHaveBeenCalledOnce();
    expect(native.update).toHaveBeenCalledExactlyOnceWith(update);
    expect(native.delete).toHaveBeenCalledExactlyOnceWith({ id: "existing" });
    expect(native.create).not.toHaveBeenCalled();
  });
  it("disposes the native RPC thenable after reading it", async () => {
    const f = nativeFixture(),
      dispose = vi.fn();
    f.native.localAutomations.list.mockReturnValueOnce(
      Object.assign(Promise.resolve({ items: [] }), { [Symbol.dispose]: dispose }),
    );
    expect(await f.bind().listAutomations()).toEqual({ items: [] });
    expect(dispose).toHaveBeenCalledOnce();
  });
  it.each(["list", "update", "delete"])("diagnoses a missing management method: %s", (method) => {
    const f = nativeFixture();
    Reflect.deleteProperty(f.native.localAutomations, method);
    expect(f.bind).toThrow(`localAutomations.${method}`);
  });
  it("keeps management available without primary-window creation/prewarm services", async () => {
    const f = nativeFixture();
    f.native.isPrimaryWindow = false;
    f.route.policy.scopedCreation = false;
    const service = f.bind();
    expect(service.creationUnavailableReason).toContain("main-window heartbeat observer");
    expect(service.creationUnavailableReason).toContain("scoped empty-chat/prewarm binding");
    expect(await service.listAutomations()).toEqual({ items: [] });
    await service.updateAutomation({ id: "existing" });
    await service.deleteAutomation("existing");
    expect(service.assertCreationAvailable).toThrow("creation is unavailable");
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.manager.startConversation).not.toHaveBeenCalled();
  });
  it("allows management when the creation factory is absent, and accepts it on a later connection", () => {
    const f = nativeFixture();
    const service = bindReviewedDesktopScheduleServices(f.native, f.scope, f.routing);
    expect(service.creationUnavailableReason).toContain("creation-input factory");
    expect(service.assertCreationAvailable).toThrow("creation-input factory");
    expect(f.bind().creationUnavailableReason).toBeNull();
  });
  it.each(["createProjectlessThreadWorkspace", "startConversation", "getConversation"])(
    "keeps management available without creation-only manager.%s",
    async (method) => {
      const f = nativeFixture();
      Reflect.deleteProperty(f.manager, method);
      const service = f.bind();
      expect(service.creationUnavailableReason).toContain(`manager.${method}`);
      expect(await service.listAutomations()).toEqual({ items: [] });
      expect(f.factory).not.toHaveBeenCalled();
    },
  );
  it.each(["scope", "hostId", "requestClient"])(
    "rejects mismatched native input-reader %s ownership",
    (key) => {
      const f = nativeFixture();
      Reflect.set(f.reader.params, key, {});
      expect(f.bind().creationUnavailableReason).toContain("reader ownership");
      expect(f.native.localAutomations.create).not.toHaveBeenCalled();
    },
  );
  it("rejects missing or ambiguous native owner scopes", () => {
    const manager = {},
      scope = {},
      registry = { scope, getForHostId: () => manager };
    expect(resolveDesktopScheduleScope([registry, registry], manager)).toBe(scope);
    expect(() => resolveDesktopScheduleScope([], manager)).toThrow("missing or ambiguous");
    expect(() =>
      resolveDesktopScheduleScope([registry, { scope: {}, getForHostId: () => manager }], manager),
    ).toThrow("missing or ambiguous");
  });
  it("uses native workspace allocation, owned creation inputs and native empty-chat readiness", async () => {
    const f = nativeFixture(),
      service = f.bind();
    expect(await service.allocate("title")).toEqual({
      cwd: "/configured-root/day/name",
      workspaceRoot: "/configured-root/day/name",
    });
    await service.validateDirectory("/explicit");
    await service.createThread({
      title: "title",
      cwd: "/explicit",
      workspaceRoot: "/explicit",
      projectless: false,
      model: "codexhost/pi-native",
    });
    const call = f.route.policy.createScheduledConversation.mock.calls[0];
    if (!call) throw new Error("Native creation was not called");
    const [params, read] = call;
    expect(params).toMatchObject({
      cwd: "/explicit",
      collaborationMode: { settings: { model: "codexhost/pi-native" } },
    });
    expect(params).not.toHaveProperty("prompt");
    (read as (input: unknown, mode: unknown) => unknown)({}, "default");
    expect(f.readInputs).toHaveBeenCalledWith({}, "default");
    expect(service.isThreadReady(threadId)).toBe(true);
    const conversation = f.manager.getConversation();
    for (const patch of [
      { resumeState: "resuming" },
      { turns: [{}] },
      { requests: [{}] },
      { pendingRequest: {} },
      { latestCollaborationMode: null },
      { currentPermissions: null },
    ]) {
      f.manager.getConversation.mockReturnValueOnce({ ...(conversation as object), ...patch });
      expect(service.isThreadReady(threadId)).toBe(false);
    }
  });
  it("rejects nonlocal or replaced managers", () => {
    const f = nativeFixture(),
      service = f.bind();
    vi.mocked(f.routing.forHost).mockReturnValue(null);
    expect(service.assertAvailable).toThrow("connection changed");
    vi.mocked(f.routing.forHost).mockReturnValue(
      f.route as unknown as ReturnType<RendererHostRouting["forHost"]>,
    );
    f.manager.getHostId = () => "remote";
    expect(f.bind).toThrow("connection changed");
  });
});
