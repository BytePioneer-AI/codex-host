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

async function fixture(adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"))) {
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
    environment: {},
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
    readOfficial: vi.fn(),
    sendOfficial: vi.fn(),
    cancelOfficial: vi.fn(),
    startOfficial: vi.fn(),
    listOfficial: vi.fn(async () => ({ threads: [], nextCursor: null })),
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
});
