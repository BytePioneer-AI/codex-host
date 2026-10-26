import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import { DesktopRequestQueue } from "../src/desktop-request-queue.js";
import type { ExternalThreadRepository } from "../src/external-thread-repository.js";
import { ExternalThreadRuntime } from "../src/external-thread-runtime.js";
import {
  ArchiveHealthError,
  ArchiveHealthService,
  commandArguments,
  descendantsOf,
  executablePath,
  isCodexProcess,
} from "../src/archive-health-service.js";

type Listed = { pid: number; ppid: number; command: string };

async function createFixture(
  options: {
    listProcesses?: () => Promise<Listed[]>;
    canRelease?: () => boolean;
    failStoreRead?: boolean;
  } = {},
) {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const opened = await adapter.open({ kind: "create", cwd: "/synthetic" });
  if (!opened.ok) throw new Error(opened.error.message);
  const nativeSessionRef = opened.value.initialState.nativeRef;
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
    find: async (targetId: string) => {
      if (options.failStoreRead) throw new Error("store read failed");
      return records.get(targetId) ?? null;
    },
    list: async () => {
      if (options.failStoreRead) throw new Error("store read failed");
      return [...records.values()];
    },
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
    idleRelease: { queue, canRelease: options.canRelease ?? (() => true) },
  });

  const thread = runtime.register({
    record,
    session: opened.value,
    sessionId: id,
    thread: { id },
    turns: [],
  });

  const notifiedArchived: string[] = [];
  const service = new ArchiveHealthService({
    repository,
    runtime,
    notifyArchived: async (archivedId) => {
      notifiedArchived.push(archivedId);
    },
    ...(options.canRelease ? { canRelease: options.canRelease } : {}),
    diagnose: vi.fn(),
    listProcesses: options.listProcesses ?? (async () => []),
  });

  return { adapter, service, records, repository, runtime, thread, id, record, notifiedArchived };
}

describe("Codex process recognition", () => {
  it("recognises the CLI and rejects the Desktop app and unrelated processes", () => {
    expect(isCodexProcess("/usr/local/bin/codex exec --model gpt-5")).toBe(true);
    expect(isCodexProcess("/opt/homebrew/bin/codex-cli app-server")).toBe(true);
    expect(isCodexProcess("node /usr/lib/codex.js app-server")).toBe(true);

    expect(isCodexProcess("/Applications/Codex.app/Contents/MacOS/Codex")).toBe(false);
    expect(isCodexProcess("/Applications/Codex.app/Contents/Frameworks/Codex Helper")).toBe(false);
    expect(isCodexProcess("/opt/codexhost/bin/codexhost-shim app-server")).toBe(false);

    expect(isCodexProcess("/bin/echo codex --help")).toBe(false);
    expect(isCodexProcess("node /tmp/unrelated.js --output /tmp/codex.js")).toBe(false);
    expect(isCodexProcess("/usr/local/bin/notcodex exec")).toBe(false);

    // A prompt that happens to mention codexhost must not hide a real CLI.
    expect(isCodexProcess("/usr/local/bin/codex exec --prompt codexhost")).toBe(true);
  });

  it("parses quoted executables and their arguments", () => {
    expect(executablePath('"/opt/my codex/bin/codex" exec')).toBe("/opt/my codex/bin/codex");
    expect(commandArguments('"/opt/my codex/bin/codex" exec --flag')).toEqual(["exec", "--flag"]);
    expect(executablePath("   ")).toBe("");
  });

  it("walks the whole descendant tree instead of direct children only", () => {
    const processes = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
      { pid: 5, ppid: 0 },
    ];
    expect([...descendantsOf(processes, 1)].sort()).toEqual([2, 3, 4]);
    expect([...descendantsOf(processes, 5)]).toEqual([]);
  });
});

describe("archive health inspection", () => {
  it("reports a failed release with an actionable hint", async () => {
    const f = await createFixture();
    vi.spyOn(f.runtime.idleRelease, "failure").mockReturnValue("Session release failed");

    const report = await f.service.inspect();
    expect(report.inconsistentThreads).toHaveLength(1);
    expect(report.inconsistentThreads[0]).toMatchObject({
      threadId: f.id,
      kind: "external",
      state: "failed",
      recoverable: true,
    });
    expect(report.summary.externalRecoverable).toBe(1);
  });

  it("reports an unavailable session", async () => {
    const f = await createFixture();
    f.thread.sessionUnavailable = true;

    const report = await f.service.inspect();
    expect(report.inconsistentThreads[0]).toMatchObject({
      state: "unavailable",
      recoverable: true,
    });
  });

  it("reports uncommitted creating records but not a normal prewarm draft", async () => {
    const f = await createFixture();
    const creatingId = hostThreadIdSchema.parse("creating-1");
    f.records.set(creatingId, { ...f.record, hostThreadId: creatingId, state: "creating" });

    const report = await f.service.inspect();
    expect(report.inconsistentThreads.find((t) => t.threadId === creatingId)).toMatchObject({
      state: "creating",
    });

    const prewarm = await createFixture();
    const prewarmId = hostThreadIdSchema.parse("prewarm-1");
    const prewarmRecord: StoredThreadRecordV1 = {
      ...prewarm.record,
      hostThreadId: prewarmId,
      state: "creating",
    };
    prewarm.records.set(prewarmId, prewarmRecord);
    const prewarmSession = await prewarm.adapter.open({
      kind: "create",
      cwd: "/synthetic-prewarm",
    });
    if (!prewarmSession.ok) throw new Error(prewarmSession.error.message);
    prewarm.runtime.register({
      record: prewarmRecord,
      session: prewarmSession.value,
      sessionId: prewarmId,
      thread: { id: prewarmId },
      turns: [],
      unsubmittedPrewarm: true,
    });
    const prewarmReport = await prewarm.service.inspect();
    expect(prewarmReport.inconsistentThreads.find((t) => t.threadId === prewarmId)).toBeUndefined();
  });

  it("reports only real CLI processes outside the Host's own process tree", async () => {
    const f = await createFixture({
      listProcesses: async () => [
        { pid: 12345, ppid: 1, command: "/usr/local/bin/codex exec --model gpt-5" },
        { pid: 20000, ppid: 1, command: "/Applications/Codex.app/Contents/MacOS/Codex" },
        { pid: process.pid, ppid: 1, command: "/usr/local/bin/codex app-server" },
      ],
    });

    const report = await f.service.inspect();
    expect(report.officialProcesses).toHaveLength(1);
    expect(report.officialProcesses[0]).toMatchObject({
      pid: 12345,
      command: "/usr/local/bin/codex exec --model gpt-5",
    });
    expect(report.summary.officialOccupied).toBe(1);
  });

  it("skips process inspection when includeOfficial is false", async () => {
    const f = await createFixture({
      listProcesses: async () => [
        { pid: 12345, ppid: 1, command: "/usr/local/bin/codex exec --model gpt-5" },
      ],
    });

    const report = await f.service.inspect({ includeOfficial: false });
    expect(report.officialProcesses).toHaveLength(0);
    expect(report.summary.officialOccupied).toBe(0);
  });

  it("surfaces a MappingStore read failure instead of reporting a healthy Host", async () => {
    const f = await createFixture({ failStoreRead: true });
    await expect(f.service.inspect()).rejects.toThrow("store read failed");
  });
});

describe("safe forced archive", () => {
  it("closes, drains, detaches, and archives without deleting history", async () => {
    const f = await createFixture();
    const close = vi.spyOn(f.thread.session, "close");
    const turns = structuredClone(f.record.turnMappings);
    const nativeRef = structuredClone(f.record.nativeSessionRef);

    const result = await f.service.forceArchive(f.id);
    expect(result).toEqual({ ok: true, threadId: f.id, archived: true });

    expect(close).toHaveBeenCalledTimes(1);
    expect(f.record.archived).toBe(true);
    expect(f.runtime.get(f.id)).toBeUndefined();
    expect(f.notifiedArchived).toContain(f.id);
    expect(f.record.turnMappings).toEqual(turns);
    expect(f.record.nativeSessionRef).toEqual(nativeRef);
  });

  it("keeps the instance loaded and reports failure when close rejects", async () => {
    const f = await createFixture();
    vi.spyOn(f.thread.session, "close").mockRejectedValue(new Error("close failed"));

    await expect(f.service.forceArchive(f.id)).rejects.toMatchObject({ code: -32075 });
    expect(f.runtime.get(f.id)).toBeDefined();
    expect(f.record.archived).toBe(false);
    expect(f.notifiedArchived).toHaveLength(0);
  });

  it("detaches a pure in-memory orphan without a MappingStore record", async () => {
    const f = await createFixture();
    const orphanId = hostThreadIdSchema.parse("orphan-in-memory");
    const second = await f.adapter.open({ kind: "create", cwd: "/synthetic-orphan" });
    if (!second.ok) throw new Error(second.error.message);
    f.runtime.register({
      record: {
        ...f.record,
        hostThreadId: orphanId,
        nativeSessionRef: second.value.initialState.nativeRef,
      },
      session: second.value,
      sessionId: orphanId,
      thread: { id: orphanId },
      turns: [],
    });

    const report = await f.service.inspect();
    expect(report.inconsistentThreads.find((t) => t.threadId === orphanId)).toMatchObject({
      state: "orphaned",
    });

    const result = await f.service.forceArchive(orphanId);
    expect(result).toEqual({ ok: true, threadId: orphanId, archived: true });
    expect(f.runtime.get(orphanId)).toBeUndefined();
  });

  it("does not treat a MappingStore read failure as a pure in-memory orphan", async () => {
    const f = await createFixture({ failStoreRead: true });

    await expect(f.service.forceArchive(f.id)).rejects.toMatchObject({ code: -32081 });
    expect(f.runtime.get(f.id)).toBeDefined();
    expect(f.record.archived).toBe(false);
  });

  it("rejects busy threads before closing anything", async () => {
    const running = await createFixture();
    running.thread.running = true;
    await expect(running.service.forceArchive(running.id)).rejects.toMatchObject({ code: -32072 });

    const active = await createFixture();
    active.thread.activeTurnId = hostTurnIdSchema.parse("turn-1");
    await expect(active.service.forceArchive(active.id)).rejects.toMatchObject({ code: -32072 });

    const background = await createFixture({ canRelease: () => false });
    await expect(background.service.forceArchive(background.id)).rejects.toMatchObject({
      code: -32072,
    });
  });

  it("rejects unknown threads", async () => {
    const f = await createFixture();
    await expect(f.service.forceArchive("missing")).rejects.toBeInstanceOf(ArchiveHealthError);
  });
});
