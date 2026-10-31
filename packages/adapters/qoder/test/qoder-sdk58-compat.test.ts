import { describe, expect, it, vi } from "vitest";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import { QoderAdapter } from "../src/qoder-adapter.js";
import type { QoderDaemonConfig, QoderSdkDaemon } from "../src/qoder-daemon-pool.js";
import {
  isQoderPlanModeId,
  mapToQoderPermissionModeExcludingPlan,
} from "../src/qoder-permission-modes.js";
import type {
  QoderOptions,
  QoderQuery,
  QoderQueryFactory,
  SDKMessage,
} from "../src/qoder-sdk-types.js";

class RecordingQuery implements QoderQuery {
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  });
  readonly setPermissionMode = vi.fn(async () => undefined);
  readonly setPlanMode = vi.fn(async () => undefined);
  readonly options: QoderOptions | undefined;

  #closed = false;
  #messages: SDKMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];

  constructor(options?: QoderOptions) {
    this.options = options;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

describe("Qoder SDK 1.0.58 compatibility", () => {
  it("maps plan to planMode instead of permissionMode", () => {
    const plan = harnessPermissionModeIdSchema.parse("plan");
    expect(isQoderPlanModeId(plan)).toBe(true);
    expect(mapToQoderPermissionModeExcludingPlan(plan)).toBeUndefined();
    expect(
      mapToQoderPermissionModeExcludingPlan(harnessPermissionModeIdSchema.parse("default")),
    ).toBe("default");
  });

  it("opens a plan session with planMode and uses setPlanMode on switch", async () => {
    const queries: RecordingQuery[] = [];
    const queryFactory: QoderQueryFactory = (input) => {
      const query = new RecordingQuery(input.options);
      queries.push(query);
      return query;
    };
    const adapter = new QoderAdapter({
      queryFactory,
      resolveExecutable: () => "/tmp/fake-qodercli",
    });

    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      environment: { CODEXHOST_THREAD_ID: "thread-a" },
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(queries[0]?.options?.planMode).toBe(true);
    expect(queries[0]?.options?.permissionMode).toBeUndefined();

    const result = await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("default"),
    });
    expect(result.ok).toBe(true);
    expect(queries[0]?.setPlanMode).toHaveBeenCalledWith(false);
    expect(queries[0]?.setPermissionMode).toHaveBeenCalledWith("default");

    await adapter.close();
  });

  function daemonHarness() {
    const queries: RecordingQuery[] = [];
    const started: Array<{ config: QoderDaemonConfig; stop: ReturnType<typeof vi.fn> }> = [];
    const queryFactory: QoderQueryFactory = (input) => {
      const query = new RecordingQuery(input.options);
      queries.push(query);
      return query;
    };
    const startDaemon = vi.fn(async (config: QoderDaemonConfig) => {
      const stop = vi.fn(async () => undefined);
      started.push({ config, stop });
      return { stop } as unknown as QoderSdkDaemon;
    });
    const adapter = new QoderAdapter({
      queryFactory,
      startDaemon,
      resolveExecutable: () => "/tmp/fake-qodercli",
    });
    return { adapter, queries, started, startDaemon };
  }

  it("keeps launch config on per-thread daemons and off daemon-bound queries", async () => {
    const { adapter, queries, started } = daemonHarness();

    expect((await adapter.inspect()).status).toBe("ready");
    expect(started).toHaveLength(1);
    expect(started[0]?.stop).toHaveBeenCalledOnce();

    const a = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      environment: { CODEXHOST_THREAD_ID: "thread-a" },
    });
    const b = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      environment: { CODEXHOST_THREAD_ID: "thread-b" },
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(started.map((entry) => entry.config.env.CODEXHOST_THREAD_ID)).toEqual([
      undefined,
      "thread-a",
      "thread-b",
    ]);
    expect(started[1]?.config).toMatchObject({
      auth: { type: "qodercli" },
      pathToQoderCLIExecutable: "/tmp/fake-qodercli",
    });
    for (const query of queries) {
      expect(query.options?.daemon).toBeDefined();
      expect(query.options).not.toHaveProperty("env");
      expect(query.options).not.toHaveProperty("auth");
      expect(query.options).not.toHaveProperty("pathToQoderCLIExecutable");
    }

    await a.value.close();
    expect(started[1]?.stop).toHaveBeenCalledOnce();
    expect(started[2]?.stop).not.toHaveBeenCalled();

    await adapter.close();
    expect(started[2]?.stop).toHaveBeenCalled();
  });

  it("shares one daemon start between sessions with the same config", async () => {
    const { adapter, started, startDaemon } = daemonHarness();
    const input = {
      kind: "create" as const,
      cwd: "/tmp",
      environment: { CODEXHOST_THREAD_ID: "thread-a" },
    };
    const [first, second] = await Promise.all([adapter.open(input), adapter.open(input)]);
    if (!first.ok || !second.ok) throw new Error("open failed");
    expect(startDaemon).toHaveBeenCalledOnce();

    await first.value.close();
    expect(started[0]?.stop).not.toHaveBeenCalled();
    await second.value.close();
    expect(started[0]?.stop).toHaveBeenCalledOnce();
    await adapter.close();
  });

  it("stops a daemon whose start was still in flight when the adapter closed", async () => {
    let finishStart: (() => void) | undefined;
    const stop = vi.fn(async () => undefined);
    const adapter = new QoderAdapter({
      queryFactory: (input) => new RecordingQuery(input.options),
      startDaemon: () =>
        new Promise<QoderSdkDaemon>((resolve) => {
          finishStart = () => resolve({ stop } as unknown as QoderSdkDaemon);
        }),
      resolveExecutable: () => "/tmp/fake-qodercli",
    });
    const opening = adapter.open({ kind: "create", cwd: "/tmp" });
    await vi.waitFor(() => expect(finishStart).toBeDefined());
    const closing = adapter.close();
    finishStart?.();
    await closing;
    expect(stop).toHaveBeenCalledOnce();
    expect((await opening).ok).toBe(false);
  });

  it("restores Plan when leaving it fails", async () => {
    const queries: RecordingQuery[] = [];
    const adapter = new QoderAdapter({
      queryFactory: (input) => {
        const query = new RecordingQuery(input.options);
        queries.push(query);
        return query;
      },
      resolveExecutable: () => "/tmp/fake-qodercli",
    });
    const opened = await adapter.open({
      kind: "create",
      cwd: "/tmp",
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    queries[0]?.setPermissionMode.mockRejectedValueOnce(new Error("rejected"));

    const result = await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("default"),
    });
    expect(result.ok).toBe(false);
    expect(queries[0]?.setPlanMode.mock.calls).toEqual([[false], [true]]);
    await adapter.close();
  });

  it("reports Plan switching as unsupported without setPlanMode", async () => {
    const adapter = new QoderAdapter({
      queryFactory: (input) => {
        const query = new RecordingQuery(input.options);
        Object.defineProperty(query, "setPlanMode", { value: undefined });
        return query;
      },
      resolveExecutable: () => "/tmp/fake-qodercli",
    });
    const opened = await adapter.open({ kind: "create", cwd: "/tmp" });
    if (!opened.ok) throw new Error(opened.error.message);
    const result = await opened.value.execute({
      type: "permissionMode.select",
      permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
    await adapter.close();
  });
});
