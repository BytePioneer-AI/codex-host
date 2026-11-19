import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessOutputChannel } from "@codexhost/harness-adapter";
import { QoderAdapter } from "../src/qoder-adapter.js";
import { encodeQoderModelRef } from "../src/qoder-models.js";
import type { QoderSdkDaemon } from "../src/qoder-daemon-pool.js";
import type {
  QoderModelInfo,
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  SDKMessage,
} from "../src/qoder-sdk-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function models(value: string): QoderModelInfo[] {
  return [{ value, displayName: value, description: "", isDefault: true }];
}

class Query implements QoderQuery {
  readonly messages = new HarnessOutputChannel<SDKMessage>();
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => this.messages.end());
  readonly initializationResult = vi.fn<() => Promise<unknown>>(async () => undefined);
  readonly getAvailableModels = vi.fn<NonNullable<QoderQuery["getAvailableModels"]>>(async () =>
    models("native-default"),
  );
  [Symbol.asyncIterator]() {
    return this.messages.outputs[Symbol.asyncIterator]();
  }
}

const adapters: QoderAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.useRealTimers();
});

describe.each(["global", "cn"] as const)("Qoder %s Session models", (variant) => {
  it.each([undefined, "explicit-model"])(
    "loads the project's own catalog after Desktop inspects without cwd (selection: %s)",
    async (selection) => {
      const cwd = path.join(process.cwd(), "project-not-host-cwd");
      const probes: Query[] = [];
      const sessionOptions: QoderOptions[] = [];
      const queryFactory = vi.fn<QoderQueryFactory>(({ prompt, options }) => {
        const query = new Query();
        if (typeof prompt === "string") {
          query.getAvailableModels.mockResolvedValue(
            options?.cwd === cwd
              ? [
                  { value: "auto", displayName: "Auto", description: "", isEnabled: false },
                  {
                    value: "project-default",
                    displayName: "Project default",
                    description: "",
                    isDefault: true,
                    efforts: ["low", "high"],
                    defaultEffort: "high",
                  },
                ]
              : models("host-default"),
          );
          probes.push(query);
        } else if (options) {
          sessionOptions.push(options);
        }
        return query;
      });
      const adapter = new QoderAdapter({
        variant,
        queryFactory,
        resolveExecutable: () => "qodercli",
      });
      adapters.push(adapter);
      const desktopInspection = await adapter.inspect();
      expect(desktopInspection).toMatchObject({
        status: "ready",
        catalog: { defaultModel: encodeQoderModelRef("host-default") },
      });

      for (let i = 0; i < 2; i += 1) {
        const opened = await adapter.open({
          kind: "create",
          cwd,
          ...(selection ? { model: encodeQoderModelRef(selection) } : {}),
        });
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.value.initialState.effectiveModel).toEqual(
          encodeQoderModelRef(selection ?? "project-default"),
        );
        expect(sessionOptions.at(-1)?.model).toBe(selection);
        if (!selection) {
          expect(opened.value.initialState.availableThinkingOptions).toEqual([
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ]);
        }
        await opened.value.close();
      }
      expect(probes).toHaveLength(2);
      expect(queryFactory.mock.calls.filter(([input]) => typeof input.prompt === "string")).toEqual(
        [
          [expect.objectContaining({ options: expect.objectContaining({ cwd: process.cwd() }) })],
          [expect.objectContaining({ options: expect.objectContaining({ cwd }) })],
        ],
      );
      for (const probe of probes) {
        expect(probe.initializationResult).toHaveBeenCalledOnce();
        expect(probe.getAvailableModels).toHaveBeenCalledExactlyOnceWith({ fetchStrategy: "live" });
        expect(probe.close).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not borrow the Host catalog when the project inspection fails", async () => {
    const host = new Query();
    const project = new Query();
    project.getAvailableModels.mockRejectedValue(new Error("Project model query failed"));
    const queryFactory = vi
      .fn<QoderQueryFactory>()
      .mockReturnValueOnce(host)
      .mockReturnValueOnce(project);
    const adapter = new QoderAdapter({
      variant,
      queryFactory,
      resolveExecutable: () => "qodercli",
    });
    adapters.push(adapter);
    await adapter.inspect();
    expect(await adapter.open({ kind: "create", cwd: "/different-project" })).toMatchObject({
      ok: false,
      error: { message: "Project model query failed" },
    });
    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(project.close).toHaveBeenCalledOnce();
  });
});

describe("Qoder model inspection deadline and shutdown", () => {
  function setup(query: Query) {
    const stop = vi.fn(async () => undefined);
    const queryFactory = vi.fn<QoderQueryFactory>(() => query);
    const adapter = new QoderAdapter({
      queryFactory,
      resolveExecutable: () => "qodercli",
      startDaemon: async () => ({ stop }) as unknown as QoderSdkDaemon,
    });
    adapters.push(adapter);
    return { adapter, queryFactory, stop };
  }

  it("allows a slow single live read within the budget, without polling", async () => {
    vi.useFakeTimers();
    const query = new Query();
    const live = deferred<QoderModelInfo[]>();
    query.getAvailableModels.mockReturnValue(live.promise);
    const { adapter, stop } = setup(query);
    const inspection = adapter.inspect();
    await vi.advanceTimersByTimeAsync(9_000);
    live.resolve(models("slow-model"));
    expect(await inspection).toMatchObject({
      status: "ready",
      catalog: { defaultModel: encodeQoderModelRef("slow-model") },
    });
    expect(query.getAvailableModels).toHaveBeenCalledExactlyOnceWith({ fetchStrategy: "live" });
    expect(query.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one deadline between initialization and live loading and ignores late results", async () => {
    vi.useFakeTimers();
    const query = new Query();
    const init = deferred<undefined>();
    const live = deferred<QoderModelInfo[]>();
    query.initializationResult.mockReturnValue(init.promise);
    query.getAvailableModels.mockReturnValue(live.promise);
    const { adapter, queryFactory, stop } = setup(query);
    const inspection = adapter.inspect({ cwd: "/project" });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(query.getAvailableModels).not.toHaveBeenCalled();
    init.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(query.getAvailableModels).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await inspection).toMatchObject({
      status: "unavailable",
      error: { message: "Qoder Model inspection timed out after 10000ms" },
    });
    expect(queryFactory.mock.calls[0]?.[0].options?.abortController?.signal.aborted).toBe(true);
    expect(query.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    live.resolve(models("late-model"));
    await vi.advanceTimersByTimeAsync(0);
    queryFactory.mockReturnValue(new Query());
    expect(await adapter.inspect({ cwd: "/project" })).toMatchObject({
      status: "ready",
      catalog: { defaultModel: encodeQoderModelRef("native-default") },
    });
    expect(queryFactory).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["initialization", "live"] as const)("cancels pending %s on close", async (stage) => {
    vi.useFakeTimers();
    const query = new Query();
    const init = deferred<undefined>();
    const live = deferred<QoderModelInfo[]>();
    if (stage === "initialization") query.initializationResult.mockReturnValue(init.promise);
    else query.getAvailableModels.mockReturnValue(live.promise);
    const { adapter, queryFactory, stop } = setup(query);
    const opening = adapter.open({ kind: "create", cwd: "/project" });
    await vi.advanceTimersByTimeAsync(0);
    await adapter.close();
    expect(await opening).toMatchObject({ ok: false });
    expect(queryFactory.mock.calls[0]?.[0].options?.abortController?.signal.aborted).toBe(true);
    expect(query.close).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    init.resolve(undefined);
    live.resolve(models("late-model"));
    await vi.advanceTimersByTimeAsync(0);
    expect(await adapter.inspect()).toMatchObject({
      status: "unavailable",
      error: { code: "invalidState" },
    });
    expect(queryFactory).toHaveBeenCalledOnce();
    if (stage === "initialization") expect(query.getAvailableModels).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains cancelled inspections even when refresh has replaced their in-flight entry", async () => {
    const first = new Query();
    first.getAvailableModels.mockReturnValue(new Promise(() => {}));
    const cleanup = deferred<undefined>();
    first.close.mockReturnValue(cleanup.promise);
    const second = new Query();
    const queryFactory = vi
      .fn<QoderQueryFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValue(second);
    const adapter = new QoderAdapter({ queryFactory, resolveExecutable: () => "qodercli" });
    adapters.push(adapter);
    const old = adapter.inspect({ cwd: "/project" });
    await vi.waitFor(() => expect(first.getAvailableModels).toHaveBeenCalledOnce());
    await adapter.inspect({ cwd: "/project", refresh: true });
    let closed = false;
    const closing = adapter.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(first.close).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    cleanup.resolve(undefined);
    await closing;
    expect(await old).toMatchObject({ status: "unavailable" });
    expect(closed).toBe(true);
  });

  it("does not let an older inspection overwrite an explicit refresh", async () => {
    const first = new Query();
    const late = deferred<QoderModelInfo[]>();
    first.getAvailableModels.mockReturnValue(late.promise);
    const second = new Query();
    const queryFactory = vi
      .fn<QoderQueryFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValue(second);
    const adapter = new QoderAdapter({ queryFactory, resolveExecutable: () => "qodercli" });
    adapters.push(adapter);
    const old = adapter.inspect({ cwd: "/project" });
    await vi.waitFor(() => expect(first.getAvailableModels).toHaveBeenCalledOnce());
    const current = await adapter.inspect({ cwd: "/project", refresh: true });
    late.resolve(models("stale-model"));
    await old;
    expect(await adapter.inspect({ cwd: "/project" })).toBe(current);
    expect(queryFactory).toHaveBeenCalledTimes(2);
  });
});
