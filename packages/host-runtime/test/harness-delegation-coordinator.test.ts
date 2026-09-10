import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { HarnessDelegationCoordinator } from "../src/harness-delegation-coordinator.js";
import { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";

async function fixture(
  adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi")),
  environment: NodeJS.ProcessEnv = {},
  officialThreadCwd: (threadId: string) => Promise<string | undefined> = async () => undefined,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-delegation-coordinator-"));
  const store = new MappingStore({ directory });
  await store.initialize();
  const repository = new ExternalThreadRepository(store);
  const adapters = new Map([["pi" as const, adapter]]);
  const registered: ReturnType<ExternalThreadRuntime["register"]>[] = [];
  const notifications: unknown[] = [];
  const runtime = new ExternalThreadRuntime({
    adapters,
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
    inspectOfficial: vi.fn(),
    readOfficial: vi.fn(),
    sendOfficial: vi.fn(),
    cancelOfficial: vi.fn(),
    startOfficial: vi.fn(),
    listOfficial: vi.fn(async () => ({ threads: [], nextCursor: null })),
    officialThreadCwd,
    activeOfficialParents: () => [],
  });
  return {
    adapter,
    coordinator,
    directory,
    notifications,
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
  it("builds follow-up commands from the Host-provided CLI path", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const cliPath = "/Applications/codexhost.app/Contents/MacOS/codexhost";
    const value = await fixture(adapter, { CODEXHOST_CLI_PATH: cliPath });
    try {
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      expect(result.next.read).toBe(`${cliPath} thread read ${result.threadId}`);
      expect(result.next.wait).toBe(`${cliPath} thread wait ${result.threadId} --timeout-ms 30000`);
    } finally {
      await value.close();
    }
  });

  it("creates a normal writable child Thread and publishes it only after initial delivery", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const value = await fixture(adapter);
    try {
      const result = await value.coordinator.start({
        harnessId: "pi",
        task: "review auth",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      expect(result).toMatchObject({ harnessId: "pi", status: "running" });
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

  it("resolves delegated cwd from explicit input, external and official parents, then process cwd", async () => {
    const adapter = new RecordingAdapter(harnessIdSchema.parse("pi"));
    const officialThreadCwd = vi.fn(async (threadId: string) =>
      threadId === "official-parent" ? "/official-workspace" : undefined,
    );
    const value = await fixture(adapter, {}, officialThreadCwd);
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
        model,
        thinkingOptionId,
      });
      expect(adapter.openInputs[0]).toMatchObject({ model, thinkingOptionId });
      expect(result.configuration?.requested).toEqual({ model, thinkingOptionId });
      expect((await value.repository.list())[0]?.transportModelId).not.toBe("codexhost/pi-native");
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

  it("keeps a manageable record when initial delivery fails after Native Session identity exists", async () => {
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
      const records = await value.repository.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.state).toBe("ready");
      const delegations = await value.repository.listDelegations();
      expect(delegations).toHaveLength(1);
      await expect(
        value.coordinator.read({ threadId: records[0]?.hostThreadId ?? "", view: "result" }),
      ).resolves.toMatchObject({ harnessId: "pi" });
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
        nextCursor: "cursor",
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
        nextCursor: "cursor",
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

  it("CREATION-01 delivers once for concurrent same request-id callers", async () => {
    const value = await fixture();
    try {
      const original = value.adapter.open.bind(value.adapter);
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let opens = 0;
      value.adapter.open = async (input) => {
        opens += 1;
        if (opens === 1) await gate;
        return original(input);
      };
      const input = {
        harnessId: "pi",
        task: "same task",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
        requestId: "concurrent-1",
      };
      const first = value.coordinator.start(input);
      const second = value.coordinator.start(input);
      await Promise.resolve();
      release();
      const [left, right] = await Promise.all([first, second]);
      expect(left.threadId).toBe(right.threadId);
      expect(left.delegationId).toBe(right.delegationId);
      expect(left.turnId).toBe(right.turnId);
      expect(left.turnId).not.toBe("pending");
      expect(opens).toBe(1);
      expect(value.adapter.sessions).toHaveLength(1);
      await expect(
        value.coordinator.read({ threadId: left.threadId, view: "result" }),
      ).resolves.toMatchObject({
        threadId: left.threadId,
      });
    } finally {
      await value.close();
    }
  });

  it("CREATION-02 rejects the same request-id with a conflicting parent or task", async () => {
    const value = await fixture();
    try {
      await value.coordinator.start({
        harnessId: "pi",
        task: "task one",
        cwd: "/synthetic",
        parentThreadId: "parent-a",
        requestId: "conflict-1",
      });
      await expect(
        value.coordinator.start({
          harnessId: "pi",
          task: "task one",
          cwd: "/synthetic",
          parentThreadId: "parent-b",
          requestId: "conflict-1",
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(
        value.coordinator.start({
          harnessId: "pi",
          task: "task two",
          cwd: "/synthetic",
          parentThreadId: "parent-a",
          requestId: "conflict-1",
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      const left = value.coordinator.start({
        harnessId: "pi",
        task: "parallel-a",
        cwd: "/synthetic",
        parentThreadId: "parent-a",
        requestId: "parallel-a",
      });
      const right = value.coordinator.start({
        harnessId: "pi",
        task: "parallel-b",
        cwd: "/synthetic",
        parentThreadId: "parent-a",
        requestId: "parallel-b",
      });
      const [first, second] = await Promise.all([left, right]);
      expect(first.threadId).not.toBe(second.threadId);
    } finally {
      await value.close();
    }
  });

  it("TURN-05 rejects a stale expected-turn without cancelling the new Turn", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      const followUp = await value.coordinator.send({
        threadId: started.threadId,
        message: "second",
      });
      await expect(
        value.coordinator.cancel({
          threadId: started.threadId,
          expectedTurnId: started.turnId,
        }),
      ).rejects.toMatchObject({ code: "STALE_TURN" });
      expect(thread.activeTurnId).toBe(followUp.turnId);
    } finally {
      await value.close();
    }
  });

  it("rejects thread release for Harnesses without owned-job quiescence", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      await expect(
        value.coordinator.release({ threadId: started.threadId }),
      ).resolves.toMatchObject({
        released: false,
        busy: false,
        quiescence: "unsupported",
      });
      expect(value.runtime.get(started.threadId)).toBeDefined();
    } finally {
      await value.close();
    }
  });

  it("rejects a stale expected-turn on release of an idle Thread", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      const followUp = await value.coordinator.send({
        threadId: started.threadId,
        message: "second",
      });
      session.succeedTurn();
      thread.running = false;
      thread.activeTurnId = null;
      thread.turns = [{ id: followUp.turnId, status: "completed" }];
      await expect(
        value.coordinator.release({
          threadId: started.threadId,
          expectedTurnId: started.turnId,
        }),
      ).rejects.toMatchObject({ code: "STALE_TURN" });
      expect(value.runtime.get(started.threadId)).toBeDefined();
    } finally {
      await value.close();
    }
  });

  it("retries send with the same request-id instead of starting a second Turn", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      const first = await value.coordinator.send({
        threadId: started.threadId,
        message: "follow-up",
        requestId: "send-1",
      });
      thread.running = false;
      thread.activeTurnId = null;
      const retry = await value.coordinator.send({
        threadId: started.threadId,
        message: "follow-up",
        requestId: "send-1",
      });
      expect(retry.turnId).toBe(first.turnId);
      expect(thread.activeTurnId).toBeNull();
      await expect(
        value.coordinator.send({
          threadId: started.threadId,
          message: "other payload",
          requestId: "send-1",
        }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await value.close();
    }
  });

  it("does not assign a failed send Turn ID to the next successful send", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      session.rejectNextTurn({
        code: "nativeFailure",
        message: "synthetic follow-up failure",
        retryable: false,
      });
      const pendingBefore = [...(thread.record.pendingHostTurnIds ?? [])];
      await expect(
        value.coordinator.send({ threadId: started.threadId, message: "failed payload" }),
      ).rejects.toMatchObject({ code: "DELEGATION_FAILED" });
      expect(thread.record.pendingHostTurnIds ?? []).toEqual(pendingBefore);
      expect(thread.activeTurnId).toBeNull();
      const success = await value.coordinator.send({
        threadId: started.threadId,
        message: "ok payload",
      });
      expect(thread.activeTurnId).toBe(success.turnId);
      expect(success.turnId).not.toBe(started.turnId);
    } finally {
      await value.close();
    }
  });

  it("reopens Delegation status to running for a follow-up Turn", async () => {
    const value = await fixture();
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      const delegation = await value.repository.getDelegationByChild(
        hostThreadIdSchema.parse(started.threadId),
      );
      if (!delegation) throw new Error("Missing delegation");
      await value.repository.setDelegationStatus(delegation.delegationId, "completed");
      await value.coordinator.send({
        threadId: started.threadId,
        message: "second",
      });
      await expect(
        value.repository.getDelegationByChild(hostThreadIdSchema.parse(started.threadId)),
      ).resolves.toMatchObject({ status: "running" });
    } finally {
      await value.close();
    }
  });

  it("does not hot-loop wait-many when a target is an official Thread", async () => {
    const value = await fixture();
    try {
      const officialId = hostThreadIdSchema.parse(randomUUID());
      const running = {
        threadId: officialId,
        harnessId: "codex" as const,
        status: "running" as const,
        turn: { turnId: "turn-1", status: "running" as const },
        progress: [],
        result: { availability: "pending" as const },
        nextCursor: "cursor",
      };
      const completed = {
        ...running,
        status: "completed" as const,
        turn: { turnId: "turn-1", status: "completed" as const },
        result: { availability: "available" as const, text: "done" },
      };
      let reads = 0;
      const read = vi.fn(async () => {
        reads += 1;
        return reads <= 2 ? running : completed;
      });
      Object.assign(value.coordinator, { read });
      const first = await value.coordinator.waitMany({
        timeoutMs: 0,
        targets: [{ threadId: officialId }],
      });
      const afterRevision = first.results[0]?.revision;
      if (!afterRevision) throw new Error("Missing official revision");
      const started = Date.now();
      const result = await value.coordinator.waitMany({
        timeoutMs: 400,
        targets: [{ threadId: officialId, afterRevision }],
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(350);
      expect(result.timedOut).toBe(false);
      expect(result.results[0]).toMatchObject({ outcome: "changed" });
    } finally {
      await value.close();
    }
  });

  it("does not return a cached send after the Session is released", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    Object.assign(adapter, {
      stopOwnedJobs: async () => ({ quiescence: "confirmed" as const }),
    });
    const value = await fixture(adapter);
    try {
      const started = await value.coordinator.start({
        harnessId: "pi",
        task: "first",
        cwd: "/synthetic",
        parentThreadId: "parent-thread",
      });
      const session = value.adapter.sessions[0];
      if (!session) throw new Error("Missing session");
      session.succeedTurn();
      const thread = value.runtime.get(started.threadId);
      if (!thread) throw new Error("Missing thread");
      thread.running = false;
      thread.activeTurnId = null;
      const first = await value.coordinator.send({
        threadId: started.threadId,
        message: "follow-up",
        requestId: "send-1",
      });
      thread.running = false;
      thread.activeTurnId = null;
      await expect(
        value.coordinator.release({ threadId: started.threadId }),
      ).resolves.toMatchObject({ released: true, quiescence: "confirmed" });
      await expect(
        value.coordinator.send({
          threadId: started.threadId,
          message: "follow-up",
          requestId: "send-1",
        }),
      ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
      expect(first.turnId).toBeTruthy();
    } finally {
      await value.close();
    }
  });
});
