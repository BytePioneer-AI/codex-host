import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { DesktopRequestQueue } from "../src/desktop-request-queue.js";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import { ArchiveHealthService, ArchiveHealthError } from "../src/archive-health-service.js";

async function createFixture() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const session = opened.value;
  const nativeSessionRef = session.initialState.nativeRef;
  if (!nativeSessionRef) throw new Error("Missing native identity");

  const records = new Map<string, StoredThreadRecordV1>();
  const id = hostThreadIdSchema.parse("thread-inconsistent-1");
  const record: StoredThreadRecordV1 = {
    formatVersion: 1,
    revision: 1,
    hostThreadId: id,
    createRequestId: "req-1",
    harnessId: adapter.harnessId,
    state: "ready",
    nativeSessionRef,
    cwd: "/synthetic",
    title: "Inconsistent Thread",
    archived: false,
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "legacy",
    turnMappings: [],
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  } as StoredThreadRecordV1;
  records.set(id, record);

  const repository = {
    find: async (targetId: string) => records.get(targetId) ?? null,
    list: async () => [...records.values()],
    setArchived: async (targetId: string, archived: boolean) => {
      const existing = records.get(targetId);
      if (existing) existing.archived = archived;
      return existing ?? null;
    },
    alignSnapshot: async () => ({ record, turns: [] }),
    sessionTreeId: async () => id,
  } as unknown as ExternalThreadRepository;

  const queue = new DesktopRequestQueue();
  const runtime = new ExternalThreadRuntime({
    adapters: new Map([["pi", adapter]]),
    repository,
    consumeOutputs: async (thread) => {
      for await (const output of thread.session.outputs) void output;
    },
    diagnose: vi.fn(),
    idleRelease: { queue, canRelease: () => true },
  });

  const thread = runtime.register({
    record,
    session,
    sessionId: id,
    thread: { id },
    turns: [],
  });

  const notifiedArchived: string[] = [];
  const notifyArchived = async (archivedId: string) => {
    notifiedArchived.push(archivedId);
  };

  const officialProcesses = [{ pid: 12345, command: "codex exec --model gpt-5 --stream" }];

  const service = new ArchiveHealthService({
    repository,
    runtime,
    notifyArchived,
    listOfficialProcesses: async () => officialProcesses,
  });

  return {
    service,
    records,
    repository,
    runtime,
    thread,
    id,
    record,
    notifiedArchived,
    officialProcesses,
  };
}

describe("ArchiveHealthService", () => {
  it("inspects and reports external thread with failed release", async () => {
    const f = await createFixture();

    // Mock idle release failure
    vi.spyOn(f.runtime.idleRelease, "failure").mockReturnValue("Session release failed");

    const report = await f.service.inspect();
    expect(report.inconsistentThreads).toHaveLength(1);
    expect(report.inconsistentThreads[0]).toMatchObject({
      threadId: f.id,
      kind: "external",
      state: "failed",
      recoverable: true,
    });
    expect(report.summary.officialOccupied).toBe(1);
    expect(report.officialProcesses[0]).toMatchObject({
      pid: 12345,
      command: "codex exec --model gpt-5 --stream",
    });
    expect(report.officialProcesses[0]?.hint).toContain("kill 12345");
  });

  it("identifies session unavailable external threads", async () => {
    const f = await createFixture();
    f.thread.sessionUnavailable = true;

    const report = await f.service.inspect();
    expect(report.inconsistentThreads).toHaveLength(1);
    expect(report.inconsistentThreads[0]).toMatchObject({
      threadId: f.id,
      kind: "external",
      state: "unavailable",
      recoverable: true,
    });
    expect(report.summary.externalRecoverable).toBe(1);
  });

  it("identifies uncommitted provisional thread records", async () => {
    const f = await createFixture();
    const provisionalId = hostThreadIdSchema.parse("provisional-1");
    const provisionalRecord: StoredThreadRecordV1 = {
      ...f.record,
      hostThreadId: provisionalId,
      state: "provisional",
    };
    f.records.set(provisionalId, provisionalRecord);

    const report = await f.service.inspect();
    const found = report.inconsistentThreads.find((t) => t.threadId === provisionalId);
    expect(found).toMatchObject({
      threadId: provisionalId,
      kind: "external",
      state: "provisional",
      recoverable: true,
    });
  });

  it("safely force-archives an external thread without deleting data", async () => {
    const f = await createFixture();
    expect(f.runtime.get(f.id)).toBeDefined();
    expect(f.record.archived).toBe(false);

    const result = await f.service.forceArchive(f.id);
    expect(result).toEqual({
      ok: true,
      threadId: f.id,
      archived: true,
    });

    // MappingStore marked archived
    expect(f.record.archived).toBe(true);

    // Detached from runtime memory
    expect(f.runtime.get(f.id)).toBeUndefined();

    // Broadcast notification sent
    expect(f.notifiedArchived).toContain(f.id);
  });

  it("rejects force-archive for non-existent thread", async () => {
    const f = await createFixture();
    await expect(f.service.forceArchive("non-existent")).rejects.toThrow(ArchiveHealthError);
  });
});
