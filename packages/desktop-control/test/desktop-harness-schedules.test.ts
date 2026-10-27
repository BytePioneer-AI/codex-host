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
  const modeAtom = {},
    eligibleAtom = {};
  const create = vi.fn(async () => ({
    item: { id: "new", kind: "heartbeat", targetThreadId: threadId },
  }));
  const readInputs = vi.fn();
  const manager = {
    getHostId: () => "local",
    createProjectlessThreadWorkspace: vi.fn(async () => ({
      cwd: "/configured-root/day/name",
      workspaceRoot: "/configured-root/day/name",
    })),
    startConversation: vi.fn(async () => ({})),
    sendRequest: vi.fn<(method: string, input: unknown) => Promise<unknown>>(async () => ({
      entries: [],
    })),
    getConversation: vi.fn(() => ({
      resumeState: "resumed",
      currentPermissions: { approvalPolicy: "on-request" },
    })),
  };
  const scope = {
    get: vi.fn((atom: unknown): unknown =>
      atom === modeAtom
        ? { settings: { model: "codexhost/pi-native" } }
        : { isEligible: atom === eligibleAtom },
    ),
    queryClient: { invalidateQueries: vi.fn(async () => {}) },
  };
  const route = {
    hostId: "local",
    manager,
    policy: {
      scopedCreation: true,
      createScheduledConversation: vi.fn(async (input: unknown, read: unknown) => {
        return { input, read };
      }),
    },
  };
  const routing = { forHost: vi.fn(() => route) } as unknown as RendererHostRouting;
  const modules = {
    shared: {
      Qot: {
        localAutomationsScheduler: {},
        localAutomations: {
          create,
          list: vi.fn(async () => ({ items: [] })),
          update: vi.fn(),
          delete: vi.fn(),
        },
        projectlessThreads: { createPaths: vi.fn() },
      },
      Yat: async (value: unknown) => value,
    },
    initial: {
      GW: () => ({ readCreationInputs: readInputs }),
      irr: () => manager,
      xSn: modeAtom,
      jzn: ["vscode", "list-automations"],
    },
    primary: { OT: eligibleAtom },
  };
  return { modules, scope, route, routing, manager, create, readInputs };
}
describe("reviewed Desktop 26.1021 services", () => {
  it("binds list/update/delete to the same native service and reads persisted ownership", async () => {
    const f = nativeFixture();
    const service = bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing);
    const native = f.modules.shared.Qot.localAutomations;
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
  it.each(["list", "update", "delete"])("rejects a Desktop service missing %s", (method) => {
    const f = nativeFixture();
    Reflect.deleteProperty(f.modules.shared.Qot.localAutomations, method);
    expect(() => bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing)).toThrow(
      "required local",
    );
  });
  it("rejects missing or ambiguous native owner scopes", () => {
    const manager = {},
      scope = {};
    const registry = { scope, getForHostId: () => manager };
    expect(resolveDesktopScheduleScope([registry, registry], manager)).toBe(scope);
    expect(() => resolveDesktopScheduleScope([], manager)).toThrow("missing or ambiguous");
    expect(() =>
      resolveDesktopScheduleScope([registry, { scope: {}, getForHostId: () => manager }], manager),
    ).toThrow("missing or ambiguous");
  });
  it("uses native workspace allocation, creation callbacks and readiness", async () => {
    const f = nativeFixture();
    const service = bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing);
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
    f.scope.get.mockReturnValueOnce(null);
    expect(service.isThreadReady(threadId)).toBe(false);
  });
  it("rejects missing native services, nonlocal or replaced managers", () => {
    const f = nativeFixture();
    expect(() =>
      bindReviewedDesktopScheduleServices({ ...f.modules, primary: {} }, f.scope, f.routing),
    ).toThrow("required local");
    const service = bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing);
    vi.mocked(f.routing.forHost).mockReturnValue(null);
    expect(service.assertAvailable).toThrow("connection changed");
    vi.mocked(f.routing.forHost).mockReturnValue(
      f.route as unknown as ReturnType<RendererHostRouting["forHost"]>,
    );
    f.manager.getHostId = () => "remote";
    expect(() => bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing)).toThrow(
      "connection changed",
    );
  });
  it("requires the primary-window scheduler service", () => {
    const f = nativeFixture();
    Reflect.deleteProperty(f.modules.shared.Qot, "localAutomationsScheduler");
    expect(() => bindReviewedDesktopScheduleServices(f.modules, f.scope, f.routing)).toThrow(
      "required local",
    );
  });
});
