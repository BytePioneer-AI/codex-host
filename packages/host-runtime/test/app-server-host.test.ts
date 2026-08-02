import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodeClaudeTransportModel,
  encodePiTransportModel,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import { harnessIdSchema, hostThreadIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";

import { AppServerHost } from "../src/index.js";

class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

class FailingOwnershipMappingStore extends MappingStore {
  override getThread(): Promise<never> {
    return Promise.reject(new Error("Synthetic ownership read failure"));
  }
}

class FailingArchiveMappingStore extends MappingStore {
  override setArchived(): Promise<never> {
    return Promise.reject(new Error("Synthetic archive write failure"));
  }
}

class FailingListMappingStore extends MappingStore {
  override listThreads(): Promise<never> {
    return Promise.reject(new Error("Synthetic list read failure"));
  }
}

class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
  }> = [];
  #buffer = "";

  constructor(stream: PassThrough) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(this.#buffer.slice(0, newline)) as JsonObject;
        this.#buffer = this.#buffer.slice(newline + 1);
        this.messages.push(message);
        const matched = this.#waiters.filter(({ predicate }) => predicate(message));
        for (const waiter of matched) waiter.resolve(message);
        for (const waiter of matched) this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return Promise.race([
      new Promise<JsonObject>((resolve) => this.#waiters.push({ predicate, resolve })),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for Host output")), 2_000),
      ),
    ]);
  }
}

function method(message: JsonObject, value: string): boolean {
  return message.method === value;
}

function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

function messageParams(message: JsonObject): JsonObject {
  return (message.params ?? {}) as JsonObject;
}

function threadStatus(message: JsonObject, threadId: string, type: string): boolean {
  const params = messageParams(message);
  return (
    method(message, "thread/status/changed") &&
    params.threadId === threadId &&
    (params.status as JsonObject | undefined)?.type === type
  );
}

function turnEvent(message: JsonObject, eventMethod: string, turnId: string): boolean {
  const params = messageParams(message);
  return (
    method(message, eventMethod) &&
    ((params.turn as JsonObject | undefined)?.id === turnId || params.turnId === turnId)
  );
}

function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function createFixture(
  options: {
    environment?: NodeJS.ProcessEnv;
    externalAdapters?: ReadonlyMap<ExternalHarnessId, FakeHarnessAdapter>;
    mappingStore?: MappingStore;
    mappingStoreDirectory?: string;
  } = {},
) {
  const adapter =
    options.externalAdapters?.get("pi") ?? new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const mappingStoreDirectory =
    options.mappingStoreDirectory ?? mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
  const mappingStore =
    options.mappingStore ?? new MappingStore({ directory: mappingStoreDirectory });
  const desktopInput = new PassThrough();
  const desktopOutput = new PassThrough();
  const diagnosticOutput = new PassThrough();
  const official = new FakeOfficialProcess();
  const collector = new JsonLineCollector(desktopOutput);
  const spawnOfficial = vi.fn(() => official as unknown as ChildProcessWithoutNullStreams);
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    mappingStore,
    ...(options.environment ? { environment: options.environment } : {}),
    externalAdapters:
      options.externalAdapters ?? new Map<ExternalHarnessId, HarnessAdapter>([["pi", adapter]]),
    spawnOfficial: spawnOfficial as unknown as typeof spawn,
  });
  const running = host.run();
  return {
    adapter,
    collector,
    desktopInput,
    diagnosticOutput,
    official,
    running,
    mappingStore,
    mappingStoreDirectory,
    spawnOfficial,
  };
}

async function startExternalThread(
  fixture: ReturnType<typeof createFixture>,
  model: string,
  id = 1,
): Promise<string> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/start",
    params: { model, cwd: "/synthetic" },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  const result = response.result as JsonObject;
  const thread = result.thread as JsonObject;
  if (typeof thread.id !== "string") throw new Error("Synthetic thread response has no ID");
  return thread.id;
}

async function startPiThread(
  fixture: ReturnType<typeof createFixture>,
  model = "codexhost/pi-native",
): Promise<string> {
  return startExternalThread(fixture, model);
}

async function startPiTurn(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  id = 2,
): Promise<string> {
  writeRequest(fixture.desktopInput, {
    id,
    method: "turn/start",
    params: { threadId, input: [{ type: "text", text: "synthetic" }] },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  const result = response.result as JsonObject;
  const turn = result.turn as JsonObject;
  if (typeof turn.id !== "string") throw new Error("Synthetic turn response has no ID");
  return turn.id;
}

async function completePiTurn(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
  requestIdValue: number,
  sessionIndex = 0,
): Promise<string> {
  const turnId = await startPiTurn(fixture, threadId, requestIdValue);
  const session = fixture.adapter.sessions[sessionIndex];
  if (!session) throw new Error("Fake Pi Session was not opened");
  await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
  session.appendText(`answer ${requestIdValue}`);
  session.succeedTurn();
  await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
  return turnId;
}

async function closeFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.desktopInput.end();
  await expect(fixture.running).resolves.toBe(0);
}

async function stopFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await closeFixture(fixture);
  rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
}

describe("AppServerHost HarnessAdapter projection", () => {
  it("handles Pi inspection locally without opening a Thread Session", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 30,
      method: "codexhost/harness/inspect",
      params: { harnessId: "pi", cwd: "/synthetic", refresh: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 30)),
    ).resolves.toMatchObject({
      result: {
        status: "ready",
        catalog: { models: [{ label: "Fake Primary" }, { label: "Fake Secondary" }] },
        capabilities: {
          configuration: { selectModel: true, selectThinkingOption: true },
          history: { fork: true, forkAcrossCwd: true },
        },
      },
    });
    expect(fixture.adapter.inspectionCalls).toBe(1);
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("dispatches inspection by registered Harness ID and rejects unknown Harnesses", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });

    writeRequest(fixture.desktopInput, {
      id: 31,
      method: "codexhost/harness/inspect",
      params: { harnessId: "claude-code", cwd: "/synthetic-claude" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 31)),
    ).resolves.toMatchObject({ result: { status: "ready" } });
    expect(claude.inspectionCalls).toBe(1);
    expect(pi.inspectionCalls).toBe(0);

    writeRequest(fixture.desktopInput, {
      id: 32,
      method: "codexhost/harness/inspect",
      params: { harnessId: "unregistered" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 32)),
    ).resolves.toMatchObject({
      error: { code: -32077, message: "Harness 'unregistered' is unavailable" },
    });
    await stopFixture(fixture);
  });

  it("inspects authoritative external and Codex Thread ownership locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 40,
      method: "codexhost/thread/inspect",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 40)),
    ).resolves.toMatchObject({
      result: {
        owner: "external",
        harnessId: "pi",
        transportModelId: "codexhost/pi-native",
        effectiveModel: { id: "fake-model-v1.primary" },
        locked: true,
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 41,
      method: "codexhost/thread/inspect",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 41))).resolves.toEqual({
      id: 41,
      result: { owner: "codex", locked: true },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("lists persisted ownership without restoring external Sessions", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const first = createFixture({
      externalAdapters: new Map([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const piThreadId = await startExternalThread(first, "codexhost/pi-native", 1);
    const claudeThreadId = await startExternalThread(
      first,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      2,
    );
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restartedPi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const restartedClaude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const restarted = createFixture({
      externalAdapters: new Map([
        ["pi", restartedPi],
        ["claude-code", restartedClaude],
      ]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    restarted.official.stdin.on("data", officialWrite);

    writeRequest(restarted.desktopInput, {
      id: 42,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["official-thread", piThreadId, claudeThreadId] },
    });
    await expect(restarted.collector.waitFor((message) => requestId(message, 42))).resolves.toEqual(
      {
        id: 42,
        result: {
          threads: [
            { threadId: "official-thread", owner: "codex" },
            { threadId: piThreadId, owner: "external", harnessId: "pi" },
            { threadId: claudeThreadId, owner: "external", harnessId: "claude-code" },
          ],
        },
      },
    );
    expect(restartedPi.sessions).toHaveLength(0);
    expect(restartedClaude.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(restarted);
  });

  it("rejects invalid or unreadable ownership-list metadata locally", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new FailingOwnershipMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 43,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["duplicate", "duplicate"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 43)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 44,
      method: "codexhost/thread/ownership/list",
      params: { threadIds: ["unreadable-thread"] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 44)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("aggregates official and External Thread rows through an internal official request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const snapshotReads = session.snapshotReads;
    const internalRequest = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(request);
        fixture.official.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              data: [{ id: "official-thread", createdAt: 1, updatedAt: 1, recencyAt: 1 }],
              nextCursor: null,
              backwardsCursor: "official-backwards",
            },
          })}\n`,
        );
      });
    });

    writeRequest(fixture.desktopInput, {
      id: 45,
      method: "thread/list",
      params: { limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    await expect(internalRequest).resolves.toMatchObject({
      method: "thread/list",
      params: { cursor: null, limit: 10, sortKey: "created_at", sortDirection: "desc" },
    });
    const response = await fixture.collector.waitFor((message) => requestId(message, 45));
    const result = response.result as JsonObject;
    const data = result.data as JsonObject[];
    expect(data.map((thread) => thread.id)).toEqual([threadId, "official-thread"]);
    expect(data[0]).toMatchObject({
      status: { type: "idle" },
      turns: [],
      preview: "",
      isPinned: false,
    });
    expect(session.snapshotReads).toBe(snapshotReads);
    expect(
      fixture.collector.messages.filter(
        (message) => typeof message.id === "string" && message.id.startsWith("codexhost:official:"),
      ),
    ).toEqual([]);
    await stopFixture(fixture);
  });

  it("fails the complete aggregated list when Store or official listing fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const failingStore = new FailingListMappingStore({ directory });
    const storeFailure = createFixture({
      mappingStore: failingStore,
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    storeFailure.official.stdin.on("data", officialWrite);
    writeRequest(storeFailure.desktopInput, { id: 46, method: "thread/list", params: {} });
    await expect(
      storeFailure.collector.waitFor((message) => requestId(message, 46)),
    ).resolves.toMatchObject({ error: { code: -32082 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(storeFailure);

    const officialFailure = createFixture();
    officialFailure.official.stdin.once("data", (chunk: Buffer) => {
      const internal = JSON.parse(chunk.toString("utf8")) as JsonObject;
      officialFailure.official.stdout.write(
        `${JSON.stringify({ id: internal.id, error: { code: -32000, message: "official failed" } })}\n`,
      );
    });
    writeRequest(officialFailure.desktopInput, { id: 47, method: "thread/list", params: {} });
    await expect(
      officialFailure.collector.waitFor((message) => requestId(message, 47)),
    ).resolves.toEqual({ id: 47, error: { code: -32000, message: "official failed" } });
    await stopFixture(officialFailure);
  });

  it("lists an unloaded External Thread after restart without restoring its Adapter", async () => {
    const first = createFixture();
    const threadId = await startPiThread(first);
    const directory = first.mappingStoreDirectory;
    await closeFixture(first);

    const restartedAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const restarted = createFixture({
      externalAdapters: new Map([["pi", restartedAdapter]]),
      mappingStoreDirectory: directory,
    });
    restarted.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      restarted.official.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result: { data: [], nextCursor: null, backwardsCursor: null },
        })}\n`,
      );
    });
    writeRequest(restarted.desktopInput, {
      id: 46,
      method: "thread/list",
      params: { limit: 10 },
    });
    const response = await restarted.collector.waitFor((message) => requestId(message, 46));
    const result = response.result as JsonObject;
    expect(result.data).toEqual([
      expect.objectContaining({
        id: threadId,
        status: { type: "notLoaded" },
        canAcceptDirectInput: null,
        turns: [],
      }),
    ]);
    expect(restartedAdapter.sessions).toHaveLength(0);
    await stopFixture(restarted);
  });

  it("forwards a future official Thread list filter unchanged without External injection", async () => {
    const fixture = createFixture();
    const request = {
      id: 47,
      method: "thread/list",
      params: { limit: 3, futureOfficialFilter: { keep: true } },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(
          `${JSON.stringify({ id: 47, result: { data: [], nextCursor: null } })}\n`,
        );
      });
    });
    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 47))).resolves.toEqual({
      id: 47,
      result: { data: [], nextCursor: null },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("archives and unarchives an active External Thread without closing its Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId, 48);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
    const before = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));

    writeRequest(fixture.desktopInput, {
      id: 49,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 49))).resolves.toEqual({
      id: 49,
      result: {},
    });
    await fixture.collector.waitFor((message) => method(message, "thread/archived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: true, nativeSessionRef: before?.nativeSessionRef });
    const archiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 49,
    );
    const archiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/archived"),
    );
    expect(archiveResponseIndex).toBeLessThan(archiveNotificationIndex);

    session.appendText("still running after archive");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));

    writeRequest(fixture.desktopInput, {
      id: 50,
      method: "thread/unarchive",
      params: { threadId },
    });
    const unarchive = await fixture.collector.waitFor((message) => requestId(message, 50));
    expect(unarchive).toMatchObject({
      result: { thread: { id: threadId, status: { type: "idle" }, turns: [] } },
    });
    await fixture.collector.waitFor((message) => method(message, "thread/unarchived"));
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false, nativeSessionRef: before?.nativeSessionRef });
    const unarchiveResponseIndex = fixture.collector.messages.findIndex(
      (message) => message.id === 50,
    );
    const unarchiveNotificationIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "thread/unarchived"),
    );
    expect(unarchiveResponseIndex).toBeLessThan(unarchiveNotificationIndex);
    expect(fixture.adapter.sessions).toHaveLength(1);
    await stopFixture(fixture);
  });

  it("does not emit an archive notification when persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const mappingStore = new FailingArchiveMappingStore({ directory });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 51)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.collector.messages.some((message) => method(message, "thread/archived"))).toBe(
      false,
    );
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId)),
    ).resolves.toMatchObject({ archived: false });
    await stopFixture(fixture);
  });

  it("manages persisted External metadata even when its Harness is not registered", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
    const seed = new MappingStore({ directory });
    await seed.initialize();
    const threadId = hostThreadIdSchema.parse("unregistered-external");
    await seed.createProvisional({
      hostThreadId: threadId,
      createRequestId: "unregistered-create",
      harnessId: harnessIdSchema.parse("pi"),
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await seed.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: {
        harnessId: harnessIdSchema.parse("pi"),
        nativeSessionId: "unregistered-native",
        formatVersion: 1,
      },
    });
    await seed.close();

    const fixture = createFixture({
      externalAdapters: new Map(),
      mappingStoreDirectory: directory,
    });
    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/archive",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 52))).resolves.toEqual({
      id: 52,
      result: {},
    });
    await expect(fixture.mappingStore.getThread(threadId)).resolves.toMatchObject({
      archived: true,
    });
    await stopFixture(fixture);
  });

  it("fails External current and future metadata updates closed without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    for (const [id, patch] of [
      [53, { isPinned: true }],
      [54, { gitInfo: { branch: "main", sha: null } }],
    ] as const) {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/metadata/update",
        params: { threadId, ...patch },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, id)),
      ).resolves.toMatchObject({
        error: { code: -32078, message: "External Thread metadata updates are unsupported" },
      });
    }
    writeRequest(fixture.desktopInput, {
      id: 58,
      method: "thread/future/manage",
      params: { threadId, futureMetadata: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 58)),
    ).resolves.toMatchObject({
      error: { code: -32076, message: "External Thread does not support thread/future/manage" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(stored).not.toHaveProperty("isPinned");
    expect(stored).not.toHaveProperty("gitInfo");
    await stopFixture(fixture);
  });

  it("forwards official Archive, Unarchive, and metadata updates unchanged", async () => {
    const fixture = createFixture();
    const officialRequests = new JsonLineCollector(fixture.official.stdin);
    const requests: JsonObject[] = [
      { id: 55, method: "thread/archive", params: { threadId: "official-thread" } },
      { id: 56, method: "thread/unarchive", params: { threadId: "official-thread" } },
      {
        id: 57,
        method: "thread/metadata/update",
        params: { threadId: "official-thread", isPinned: true },
      },
    ];
    for (const request of requests) {
      writeRequest(fixture.desktopInput, request);
      await expect(
        officialRequests.waitFor((message) => message.id === request.id),
      ).resolves.toEqual(request);
      const result = request.id === 55 ? {} : { thread: { id: "official-thread" } };
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      await fixture.collector.waitFor((message) => message.id === request.id);
    }
    const notification = {
      method: "thread/archived",
      params: { threadId: "official-thread" },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/archived")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("preserves the Desktop Thread persistence mode for an external Harness", async () => {
    const fixture = createFixture();
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        ephemeral: false,
        historyMode: "legacy",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 1)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/started")),
    ).resolves.toMatchObject({
      params: {
        thread: { ephemeral: false, historyMode: "legacy", source: "vscode" },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        ephemeral: true,
        historyMode: "paginated",
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      result: {
        thread: { ephemeral: true, historyMode: "paginated", source: "vscode" },
      },
    });
    await stopFixture(fixture);
  });

  it("pages external Turns and Items with paginated resume bootstrap", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/start",
      params: {
        model: "codexhost/pi-native",
        cwd: "/synthetic",
        historyMode: "paginated",
      },
    });
    const started = await fixture.collector.waitFor((message) => requestId(message, 10));
    const threadId = ((started.result as JsonObject).thread as JsonObject).id;
    if (typeof threadId !== "string") throw new Error("Paginated Thread has no ID");
    await completePiTurn(fixture, threadId, 11);
    const secondTurnId = await completePiTurn(fixture, threadId, 12);
    const thirdTurnId = await completePiTurn(fixture, threadId, 13);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Paginated Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 14,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 14)),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    writeRequest(fixture.desktopInput, {
      id: 15,
      method: "thread/turns/list",
      params: { threadId, limit: 2, itemsView: "summary" },
    });
    const turnsPage = await fixture.collector.waitFor((message) => requestId(message, 15));
    expect(turnsPage).toMatchObject({
      result: {
        data: [
          {
            id: thirdTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
          {
            id: secondTurnId,
            itemsView: "summary",
            items: [{ type: "userMessage" }, { type: "agentMessage" }],
          },
        ],
        nextCursor: expect.any(String),
        backwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 16,
      method: "thread/items/list",
      params: { threadId, turnId: thirdTurnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 16)),
    ).resolves.toMatchObject({
      result: {
        data: [
          { turnId: thirdTurnId, item: { type: "userMessage" } },
          { turnId: thirdTurnId, item: { type: "agentMessage" } },
        ],
      },
    });
    expect(session.snapshotReads).toBe(1);

    writeRequest(fixture.desktopInput, {
      id: 17,
      method: "thread/resume",
      params: {
        threadId,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, itemsView: "summary" },
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 17)),
    ).resolves.toMatchObject({
      result: {
        thread: { id: threadId, turns: [] },
        initialTurnsPage: { data: [{ id: thirdTurnId }] },
        turnsBackwardsCursor: expect.any(String),
        itemsBackwardsCursor: expect.any(String),
      },
    });
    expect(session.snapshotReads).toBe(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("selects an existing Pi Thread Model from ordered Session state", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 31,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 31)),
    ).resolves.toMatchObject({
      id: 31,
      result: {
        effectiveModel: model,
        effectiveThinkingOptionId: "off",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
        ],
      },
    });
    expect(fixture.adapter.sessions[0]?.state.effectiveModel).toEqual(model);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("selects a registered non-Pi Thread Model through its owning Session", async () => {
    const pi = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claude = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", pi],
        ["claude-code", claude],
      ]),
    });
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID);
    const model = claude.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake Claude catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({
      id: 33,
      result: { effectiveModel: model, effectiveThinkingOptionId: "off" },
    });
    expect(claude.sessions[0]?.state.effectiveModel).toEqual(model);
    expect(pi.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("selects existing Thread Thinking from ordered complete Session state", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const off = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake catalog has no Off Thinking option");

    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({
      id: 34,
      result: {
        effectiveModel: fixture.adapter.catalog.defaultModel,
        effectiveThinkingOptionId: "off",
        availableThinkingOptions: [
          { id: "off", label: "Off" },
          { id: "high", label: "High" },
        ],
      },
    });
    expect(fixture.adapter.sessions[0]?.state.effectiveThinkingOptionId).toBe("off");
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects fixed Model control for an unknown or Codex-owned Thread locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const model = fixture.adapter.catalog.models[0]?.ref;
    if (!model) throw new Error("Fake catalog is empty");

    writeRequest(fixture.desktopInput, {
      id: 35,
      method: "codexhost/thread/model/select",
      params: { threadId: "official-thread", model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 35)),
    ).resolves.toMatchObject({ error: { code: -32078 } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a Pi Model selection while its Turn is active", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");

    writeRequest(fixture.desktopInput, {
      id: 32,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 32)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: expect.stringContaining("active") },
    });
    const off = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake catalog has no Off Thinking option");
    writeRequest(fixture.desktopInput, {
      id: 36,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 36)),
    ).resolves.toMatchObject({
      error: { code: -32078, message: expect.stringContaining("active") },
    });
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("binds a selected Pi Model and Thinking carrier to create and later Turn routing", async () => {
    const fixture = createFixture();
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const low = fixture.adapter.catalog.thinkingOptions.find(({ id }) => id === "low")?.id;
    if (!low) throw new Error("Fake catalog has no Low Thinking option");
    const carrier = encodePiTransportModel(model, low);
    const threadId = await startPiThread(fixture, carrier);

    expect(fixture.adapter.sessions[0]?.initialState).toMatchObject({
      effectiveModel: model,
      effectiveThinkingOptionId: low,
    });
    expect(
      (fixture.collector.messages.find((message) => requestId(message, 1))?.result as JsonObject)
        .model,
    ).toBe(carrier);
    writeRequest(fixture.desktopInput, {
      id: 33,
      method: "turn/start",
      params: {
        threadId,
        model: carrier,
        input: [{ type: "text", text: "selected" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 33)),
    ).resolves.toMatchObject({ result: { turn: { status: "inProgress" } } });
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("rejects malformed selected Pi carriers without forwarding or stopping Host", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 34,
      method: "thread/start",
      params: { model: "codexhost/pi-native@provider/model", cwd: "/synthetic" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 34)),
    ).resolves.toMatchObject({
      error: { code: -32602, message: expect.stringContaining("Model Ref") },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects early Adapter outputs after the turn/start response and supports thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.appendText("fake output");
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const startedIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/started"),
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(responseIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    const readResponse = await fixture.collector.waitFor((message) => requestId(message, 3));
    expect(readResponse).toMatchObject({
      result: { thread: { turns: [{ status: "completed" }] } },
    });
    await stopFixture(fixture);
  });

  it("projects live and historical Reasoning through the native summary lane", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "reasoning" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    const reasoningId = session.startReasoning("visible ");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/started") &&
          ((message.params as JsonObject).item as JsonObject | undefined)?.id === reasoningId,
      ),
    ).resolves.toMatchObject({
      params: { item: { type: "reasoning", summary: [], content: [] } },
    });
    await fixture.collector.waitFor((message) =>
      method(message, "item/reasoning/summaryPartAdded"),
    );
    session.appendReasoning(reasoningId, "analysis");
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "item/reasoning/summaryTextDelta") &&
          (message.params as JsonObject).delta === "analysis",
      ),
    ).resolves.toMatchObject({ params: { summaryIndex: 0 } });
    session.completeItem(reasoningId, { status: "succeeded" });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === reasoningId,
    );
    session.appendText("answer");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          items: [
            { id: reasoningId, type: "reasoning", summary: ["visible analysis"], content: [] },
            { type: "agentMessage", text: "answer" },
          ],
        },
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          turns: [
            {
              items: [
                { type: "userMessage" },
                {
                  id: reasoningId,
                  type: "reasoning",
                  summary: ["visible analysis"],
                  content: [],
                },
                { type: "agentMessage", text: "answer" },
              ],
            },
          ],
        },
      },
    });
    await stopFixture(fixture);
  });

  it("orders early and terminal Usage updates and replays current Usage after thread/read", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.publishUsageOnNextTurn({
      totalTokens: 30,
      contextUsedTokens: 20,
      contextWindowTokens: 100,
    });

    const turnId = await startPiTurn(fixture, threadId, 2);
    const earlyUsage = await fixture.collector.waitFor(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        messageParams(message).threadId === threadId,
    );
    expect(earlyUsage).toMatchObject({
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 30 },
          last: { totalTokens: 20, inputTokens: 20 },
          modelContextWindow: 100,
        },
      },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 2));
    const earlyUsageIndex = fixture.collector.messages.indexOf(earlyUsage);
    expect(earlyUsageIndex).toBeGreaterThan(responseIndex);

    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));
    session.publishUsage(
      { totalTokens: 44, contextUsedTokens: 25, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(turnId),
    );
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(1);
    });
    const terminalIndex = fixture.collector.messages.findIndex((message) =>
      turnEvent(message, "turn/completed", turnId),
    );
    const idleIndex = fixture.collector.messages.findIndex((message) =>
      threadStatus(message, threadId, "idle"),
    );
    const terminalUsageIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(idleIndex).toBeGreaterThan(terminalIndex);
    expect(terminalUsageIndex).toBeGreaterThan(idleIndex);

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    await vi.waitFor(() => {
      expect(
        fixture.collector.messages.filter(
          (message) =>
            method(message, "thread/tokenUsage/updated") &&
            ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens ===
              44,
        ),
      ).toHaveLength(2);
    });
    const readResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 3),
    );
    const replayIndex = fixture.collector.messages.findLastIndex(
      (message) =>
        method(message, "thread/tokenUsage/updated") &&
        ((messageParams(message).tokenUsage as JsonObject).total as JsonObject).totalTokens === 44,
    );
    expect(replayIndex).toBeGreaterThan(readResponseIndex);

    const stored = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(threadId));
    expect(JSON.stringify(stored)).not.toMatch(/usage|cost|context/i);
    await stopFixture(fixture);
  });

  it("keeps Usage isolated across registered Harness Threads", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const piThreadId = await startExternalThread(fixture, "codexhost/pi-native", 10);
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      11,
    );
    const piTurnId = await completePiTurn(fixture, piThreadId, 12, 0);
    const claudeTurnId = await completePiTurn(
      { ...fixture, adapter: claudeAdapter },
      claudeThreadId,
      13,
      0,
    );
    piAdapter.sessions[0]?.publishUsage(
      { totalTokens: 10, contextUsedTokens: 2, contextWindowTokens: 100 },
      hostTurnIdSchema.parse(piTurnId),
    );
    claudeAdapter.sessions[0]?.publishUsage(
      { totalTokens: 90, contextUsedTokens: 70, contextWindowTokens: 200 },
      hostTurnIdSchema.parse(claudeTurnId),
    );

    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === piThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 10 } } } });
    await expect(
      fixture.collector.waitFor(
        (message) =>
          method(message, "thread/tokenUsage/updated") &&
          messageParams(message).threadId === claudeThreadId,
      ),
    ).resolves.toMatchObject({ params: { tokenUsage: { total: { totalTokens: 90 } } } });
    await stopFixture(fixture);
  });

  it("forks external inclusive, exclusive, and tail boundaries without reusing Host Turn IDs", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds: [string, string, string] = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    const forkRequest = async (id: number, params: JsonObject): Promise<JsonObject> => {
      writeRequest(fixture.desktopInput, {
        id,
        method: "thread/fork",
        params: { threadId: sourceThreadId, ...params },
      });
      const response = await fixture.collector.waitFor((message) => requestId(message, id));
      const result = response.result as JsonObject;
      return result.thread as JsonObject;
    };

    const inclusive = await forkRequest(10, {
      lastTurnId: sourceTurnIds[0],
      cwd: "/synthetic-worktree/inclusive",
      runtimeWorkspaceRoots: ["/synthetic-worktree/inclusive", "/synthetic"],
    });
    const exclusive = await forkRequest(11, { beforeTurnId: sourceTurnIds[1] });
    const tail = await forkRequest(12, {});
    const excluded = await forkRequest(13, { excludeTurns: true });

    expect(inclusive).toMatchObject({
      forkedFromId: sourceThreadId,
      parentThreadId: null,
      cwd: "/synthetic-worktree/inclusive",
      turns: [expect.objectContaining({ status: "completed" })],
    });
    expect(exclusive.turns).toHaveLength(1);
    expect(tail.turns).toHaveLength(3);
    expect(excluded.turns).toEqual([]);
    const inclusiveTurnId = (inclusive.turns as JsonObject[])[0]?.id;
    expect(inclusiveTurnId).not.toBe(sourceTurnIds[0]);
    expect(inclusive.id).not.toBe(sourceThreadId);
    expect(exclusive.id).not.toBe(inclusive.id);

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 10));
    const notificationIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "thread/started") &&
        (messageParams(message).thread as JsonObject | undefined)?.id === inclusive.id,
    );
    expect(notificationIndex).toBeGreaterThan(responseIndex);

    await completePiTurn(fixture, inclusive.id as string, 20, 1);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("realizes Desktop Worktree tail-Fork plus rollback as one exact derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    const sourceTurnIds = [
      await completePiTurn(fixture, sourceThreadId, 2),
      await completePiTurn(fixture, sourceThreadId, 3),
      await completePiTurn(fixture, sourceThreadId, 4),
    ];

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId: sourceThreadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
      },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    expect(forkResponse.result).toMatchObject({
      cwd: "/synthetic-worktree",
      runtimeWorkspaceRoots: ["/synthetic-worktree", "/synthetic"],
    });
    const forkedThread = (forkResponse.result as JsonObject).thread as JsonObject;
    const derivedId = forkedThread.id;
    const initialDerivedTurns = forkedThread.turns as JsonObject[];
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    expect(forkedThread.cwd).toBe("/synthetic-worktree");
    expect(initialDerivedTurns).toHaveLength(3);

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    const rollbackResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const rolledBack = (rollbackResponse.result as JsonObject).thread as JsonObject;
    expect(rolledBack).toMatchObject({
      id: derivedId,
      forkedFromId: sourceThreadId,
      turns: [{ id: initialDerivedTurns[0]?.id, status: "completed" }],
    });
    const derivedRecord = await fixture.mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    expect(derivedRecord).toMatchObject({
      nativeSessionRef: { nativeSessionId: "fake-session-3" },
      cwd: "/synthetic-worktree",
      forkSource: { hostThreadId: sourceThreadId, hostTurnId: sourceTurnIds[0] },
      turnMappings: [
        {
          hostTurnId: initialDerivedTurns[0]?.id,
          nativeTurnRef: { nativeSessionId: "fake-session-3" },
          nativeCheckpointRef: { nativeSessionId: "fake-session-3" },
        },
      ],
    });
    expect(fixture.adapter.sessions[0]?.cwd).toBe("/synthetic");
    expect(fixture.adapter.sessions[1]?.cwd).toBe("/synthetic-worktree");
    expect(fixture.adapter.sessions[2]?.cwd).toBe("/synthetic-worktree");
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    await completePiTurn(fixture, derivedId, 20, 2);
    await completePiTurn(fixture, sourceThreadId, 21, 0);
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}] },
    });
    await expect(fixture.adapter.sessions[0]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}, {}] },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects rollback when an external Thread is not an untouched derived prefix", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/rollback",
      params: { threadId: sourceThreadId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 11));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    await completePiTurn(fixture, derivedId, 12, 1);

    writeRequest(fixture.desktopInput, {
      id: 13,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 1 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 13)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(fixture.adapter.sessions).toHaveLength(2);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("commits excluded Fork mappings before a later thread/read", async () => {
    const fixture = createFixture();
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId, excludeTurns: true },
    });
    const forked = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forked.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Fork response has no derived Thread ID");
    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}] } } });
    await stopFixture(fixture);
  });

  it("reads and updates persisted external metadata without restoring history", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-metadata-test-"));
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok || !opened.value.initialState.nativeRef) {
      throw new Error("Fake persisted Session was not created");
    }
    const source = adapter.sessions[0];
    if (!source) throw new Error("Fake persisted Session was not opened");
    const threadId = hostThreadIdSchema.parse("metadata-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "metadata-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Before",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: opened.value.initialState.nativeRef,
    });
    await store.close();

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 51,
      method: "thread/name/set",
      params: { threadId, name: "After" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 51))).resolves.toEqual({
      id: 51,
      result: {},
    });

    writeRequest(fixture.desktopInput, {
      id: 52,
      method: "thread/read",
      params: { threadId, includeTurns: false },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 52)),
    ).resolves.toMatchObject({ result: { thread: { id: threadId, name: "After", turns: [] } } });
    writeRequest(fixture.desktopInput, {
      id: 53,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 53)),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(source.snapshotReads).toBe(0);
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("restores Store-owned external read, resume, and Fork on demand", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-restart-test-"));
    const adapter = new FakeHarnessAdapter(
      harnessIdSchema.parse("pi"),
      undefined,
      undefined,
      undefined,
      { totalTokens: 77, contextUsedTokens: 33, contextWindowTokens: 200 },
    );
    const opened = await adapter.open({ kind: "create", cwd: "/persisted" });
    if (!opened.ok) throw new Error(opened.error.message);
    const source = opened.value;
    const persistedTurnId = hostTurnIdSchema.parse("persisted-turn");
    await source.execute({
      type: "turn.start",
      turnId: persistedTurnId,
      input: [{ type: "text", text: "persisted question" }],
    });
    const fakeSource = adapter.sessions[0];
    if (!fakeSource) throw new Error("Fake persisted Session was not opened");
    fakeSource.appendText("persisted answer");
    fakeSource.succeedTurn();
    const snapshot = await source.readSnapshot();
    if (!snapshot.ok || !source.initialState.nativeRef || !snapshot.value.turns[0]) {
      throw new Error("Fake persisted Snapshot was not created");
    }

    const threadId = hostThreadIdSchema.parse("persisted-thread");
    const store = new MappingStore({ directory });
    await store.initialize();
    await store.createProvisional({
      hostThreadId: threadId,
      createRequestId: "persisted-create",
      harnessId: adapter.harnessId,
      cwd: "/persisted",
      title: "Persisted Pi",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "legacy",
    });
    await store.commitReady({
      hostThreadId: threadId,
      nativeSessionRef: source.initialState.nativeRef,
      turnMappings: [
        {
          hostTurnId: persistedTurnId,
          nativeTurnRef: snapshot.value.turns[0].nativeTurnRef,
          nativeCheckpointRef: snapshot.value.turns[0].checkpoint,
        },
      ],
    });
    await store.close();

    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      mappingStoreDirectory: directory,
    });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    writeRequest(fixture.desktopInput, {
      id: 60,
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 60)),
    ).resolves.toMatchObject({
      result: {
        thread: {
          id: threadId,
          name: "Persisted Pi",
          turns: [{ id: persistedTurnId, status: "completed" }],
        },
      },
    });
    const restoredUsage = await fixture.collector.waitFor((message) =>
      method(message, "thread/tokenUsage/updated"),
    );
    expect(restoredUsage).toMatchObject({
      params: {
        threadId,
        turnId: persistedTurnId,
        tokenUsage: { total: { totalTokens: 77 }, modelContextWindow: 200 },
      },
    });
    expect(fixture.collector.messages.indexOf(restoredUsage)).toBeGreaterThan(
      fixture.collector.messages.findIndex((message) => requestId(message, 60)),
    );
    expect(fakeSource.snapshotReads).toBe(2);

    writeRequest(fixture.desktopInput, {
      id: 61,
      method: "thread/resume",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 61)),
    ).resolves.toMatchObject({
      result: {
        thread: { id: threadId, turns: [{ id: persistedTurnId }] },
        model: "codexhost/pi-native",
        initialTurnsPage: null,
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 62,
      method: "thread/fork",
      params: {
        threadId,
        lastTurnId: persistedTurnId,
        cwd: "/persisted-worktree",
        runtimeWorkspaceRoots: ["/persisted-worktree", "/persisted"],
      },
    });
    const restartedFork = await fixture.collector.waitFor((message) => requestId(message, 62));
    expect(restartedFork).toMatchObject({
      result: {
        cwd: "/persisted-worktree",
        thread: {
          id: expect.not.stringMatching(/^persisted-thread$/u),
          cwd: "/persisted-worktree",
          forkedFromId: threadId,
          turns: [{ status: "completed" }],
        },
      },
    });
    const restartedDerivedId = ((restartedFork.result as JsonObject).thread as JsonObject).id;
    if (typeof restartedDerivedId !== "string") throw new Error("Restarted Fork has no ID");
    await expect(
      fixture.mappingStore.getThread(hostThreadIdSchema.parse(restartedDerivedId)),
    ).resolves.toMatchObject({ cwd: "/persisted-worktree" });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("forwards an unknown Codex thread/fork frame unchanged", async () => {
    const fixture = createFixture();
    const request = {
      id: 90,
      method: "thread/fork",
      params: {
        threadId: "official-thread",
        lastTurnId: "one",
        beforeTurnId: "two",
        cwd: "official-relative-worktree",
        runtimeWorkspaceRoots: ["official-relative-worktree"],
        extraOfficialField: { keep: true },
      },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(`${JSON.stringify({ id: 90, result: {} })}\n`);
      });
    });
    writeRequest(fixture.desktopInput, request);

    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 90))).resolves.toEqual({
      id: 90,
      result: {},
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards an unknown Codex thread/rollback frame unchanged", async () => {
    const fixture = createFixture();
    const request = {
      id: 91,
      method: "thread/rollback",
      params: {
        threadId: "official-thread",
        numTurns: "official-shape-is-transparent",
        extraOfficialField: { keep: true },
      },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(`${JSON.stringify({ id: 91, result: {} })}\n`);
      });
    });
    writeRequest(fixture.desktopInput, request);

    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 91))).resolves.toEqual({
      id: 91,
      result: {},
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("rejects Fork while the external source Turn is active", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);
    const activeTurnId = await startPiTurn(fixture, threadId, 3);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32072 } });
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();

    const source = fixture.adapter.sessions[0];
    source?.appendText("done");
    source?.succeedTurn();
    await fixture.collector.waitFor((message) =>
      turnEvent(message, "turn/completed", activeTurnId),
    );
    await stopFixture(fixture);
  });

  it("rejects unsafe external Fork overrides without official fallback", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const firstTurnId = await completePiTurn(fixture, threadId, 2);

    const invalidForks: Array<{ id: number; params: JsonObject; code: number }> = [
      { id: 10, params: { path: "/another/session.jsonl" }, code: -32602 },
      { id: 11, params: { beforeTurnId: firstTurnId }, code: -32080 },
      { id: 12, params: { lastTurnId: "unknown-turn" }, code: -32080 },
      {
        id: 13,
        params: { lastTurnId: firstTurnId, beforeTurnId: firstTurnId },
        code: -32602,
      },
      { id: 14, params: { cwd: "relative-worktree" }, code: -32602 },
      {
        id: 15,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["relative-root"] },
        code: -32602,
      },
      {
        id: 16,
        params: { cwd: "/worktree", runtimeWorkspaceRoots: ["/source-only"] },
        code: -32602,
      },
    ];
    for (const invalid of invalidForks) {
      writeRequest(fixture.desktopInput, {
        id: invalid.id,
        method: "thread/fork",
        params: { threadId, ...invalid.params },
      });
      await expect(
        fixture.collector.waitFor((message) => requestId(message, invalid.id)),
      ).resolves.toMatchObject({ error: { code: invalid.code } });
    }
    expect(fixture.adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("rejects a changed Fork cwd when the Adapter supports only source-cwd Fork", async () => {
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"), undefined, true, false);
    const fixture = createFixture({ externalAdapters: new Map([["pi", adapter]]) });
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    await completePiTurn(fixture, threadId, 2);

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: {
        threadId,
        cwd: "/synthetic-worktree",
        runtimeWorkspaceRoots: ["/synthetic-worktree"],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32076 } });
    expect(adapter.sessions).toHaveLength(1);
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("projects a failed terminal when live Turn identity persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-write-failure-"));
    let failTurnCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failTurnCommit && record.turnMappings.length > 0) {
          throw new Error("synthetic terminal commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    failTurnCommit = true;
    const turnId = await startPiTurn(fixture, threadId, 2);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.appendText("native success");
    session.succeedTurn();

    await expect(
      fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId)),
    ).resolves.toMatchObject({
      params: {
        turn: { status: "failed", error: { message: expect.stringContaining("persisted") } },
      },
    });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(threadId))).resolves.toMatchObject(
      {
        turnMappings: [],
      },
    );
    await stopFixture(fixture);
  });

  it("closes and hides a derived runtime when Fork commit fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-fork-failure-"));
    let failForkCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failForkCommit && record.state === "ready" && record.forkSource) {
          throw new Error("synthetic derived commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const threadId = await startPiThread(fixture);
    const turnId = await completePiTurn(fixture, threadId, 2);
    failForkCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId, lastTurnId: turnId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 10)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(mappingStore.listThreads()).resolves.toHaveLength(1);
    await stopFixture(fixture);
  });

  it("keeps the temporary derived Session authoritative when rollback commit fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codexhost-host-rollback-failure-"));
    let failRollbackCommit = false;
    const mappingStore = new MappingStore({
      directory,
      beforeReplace(record) {
        if (failRollbackCommit && record.state === "ready" && record.turnMappings.length === 1) {
          throw new Error("synthetic rollback commit failure");
        }
      },
    });
    const fixture = createFixture({ mappingStore, mappingStoreDirectory: directory });
    const sourceThreadId = await startPiThread(fixture);
    await completePiTurn(fixture, sourceThreadId, 2);
    await completePiTurn(fixture, sourceThreadId, 3);
    await completePiTurn(fixture, sourceThreadId, 4);
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "thread/fork",
      params: { threadId: sourceThreadId },
    });
    const forkResponse = await fixture.collector.waitFor((message) => requestId(message, 10));
    const derivedId = ((forkResponse.result as JsonObject).thread as JsonObject).id;
    if (typeof derivedId !== "string") throw new Error("Tail Fork response has no Thread ID");
    const before = await mappingStore.getThread(hostThreadIdSchema.parse(derivedId));
    failRollbackCommit = true;

    writeRequest(fixture.desktopInput, {
      id: 11,
      method: "thread/rollback",
      params: { threadId: derivedId, numTurns: 2 },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 11)),
    ).resolves.toMatchObject({ error: { code: -32081 } });
    await expect(mappingStore.getThread(hostThreadIdSchema.parse(derivedId))).resolves.toEqual(
      before,
    );
    await expect(fixture.adapter.sessions[2]?.readSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalidState" },
    });
    await expect(fixture.adapter.sessions[1]?.readSnapshot()).resolves.toMatchObject({
      ok: true,
      value: { turns: [{}, {}, {}] },
    });

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "thread/read",
      params: { threadId: derivedId, includeTurns: true },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 12)),
    ).resolves.toMatchObject({ result: { thread: { turns: [{}, {}, {}] } } });
    await stopFixture(fixture);
  });

  it("returns the Thread to idle after every Turn in the same Session", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const turnIds: string[] = [];

    for (const requestIdValue of [2, 3]) {
      const turnId = await startPiTurn(fixture, threadId, requestIdValue);
      turnIds.push(turnId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", turnId));
      session.appendText(`output ${requestIdValue}`);
      session.succeedTurn();
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
      const completedTurnCount = requestIdValue - 1;
      await fixture.collector.waitFor(
        (message) =>
          threadStatus(message, threadId, "idle") &&
          fixture.collector.messages.filter((candidate) =>
            threadStatus(candidate, threadId, "idle"),
          ).length >= completedTurnCount,
      );
    }

    const statuses = fixture.collector.messages.flatMap((message) => {
      if (!method(message, "thread/status/changed")) return [];
      const params = messageParams(message);
      if (params.threadId !== threadId) return [];
      const status = params.status as JsonObject | undefined;
      return typeof status?.type === "string" ? [status.type] : [];
    });
    expect(statuses).toEqual(["active", "idle", "active", "idle"]);
    for (const [turnIndex, turnId] of turnIds.entries()) {
      const completedIndex = fixture.collector.messages.findIndex((message) =>
        turnEvent(message, "turn/completed", turnId),
      );
      const idleIndexes = fixture.collector.messages.flatMap((message, messageIndex) =>
        threadStatus(message, threadId, "idle") ? [messageIndex] : [],
      );
      expect(completedIndex).toBeGreaterThanOrEqual(0);
      expect(idleIndexes[turnIndex]).toBeGreaterThan(completedIndex);
    }

    writeRequest(fixture.desktopInput, {
      id: 4,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 4)),
    ).resolves.toMatchObject({ result: { thread: { status: { type: "idle" } } } });
    await stopFixture(fixture);
  });

  it("updates a Pi Thread name locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/name/set",
      params: { threadId, name: "Pi Thread" },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/name/updated")),
    ).resolves.toMatchObject({ params: { threadId, threadName: "Pi Thread" } });
    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/read",
      params: { threadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 3)),
    ).resolves.toMatchObject({ result: { thread: { name: "Pi Thread" } } });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("deletes an unused Pi prewarm locally", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    const close = vi.spyOn(session, "close");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "thread/delete",
      params: { threadId },
    });

    await expect(fixture.collector.waitFor((message) => requestId(message, 2))).resolves.toEqual({
      id: 2,
      result: {},
    });
    expect(close).toHaveBeenCalledOnce();
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("deletes an active external Thread after retiring its pending Question", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof questionRequest.id !== "number" || !Number.isSafeInteger(questionRequest.id)) {
      throw new Error("Question request has no numeric Host ID");
    }

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "thread/delete",
      params: { threadId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    writeRequest(fixture.desktopInput, {
      id: questionRequest.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).not.toContain(questionRequest.id);
    await stopFixture(fixture);
  });

  it("returns a command error without lifecycle notifications for a rejected Turn", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.rejectNextTurn({
      code: "unavailable",
      message: "synthetic rejection",
      retryable: true,
    });

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "rejected" }] },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32073, message: "synthetic rejection" },
    });
    expect(fixture.collector.messages.some((message) => method(message, "turn/started"))).toBe(
      false,
    );
    await stopFixture(fixture);
  });

  it("projects a visible native failure before the failed Turn terminal", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "failed" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 2));
    session.startReasoning("visible failure context");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.type === "reasoning",
    );
    session.failTurn({
      code: "nativeFailure",
      message: '503: {"message":"Service temporarily unavailable","type":"api_error"}',
      retryable: false,
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "failed",
          error: {
            message: expect.stringContaining("Service temporarily unavailable"),
            codexErrorInfo: "other",
            additionalDetails: null,
          },
        },
      },
    });
    const visibleError = fixture.collector.messages.find((message) => method(message, "error"));
    expect(visibleError).toMatchObject({
      params: {
        error: {
          message: expect.stringContaining("Service temporarily unavailable"),
          codexErrorInfo: "other",
          additionalDetails: null,
        },
        willRetry: false,
        threadId,
      },
    });

    const itemIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "item/completed"),
    );
    const errorIndex = fixture.collector.messages.findIndex((message) => method(message, "error"));
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThan(itemIndex);
    expect(turnIndex).toBeGreaterThan(errorIndex);
    await stopFixture(fixture);
  });

  it("projects Command, Generic Tool, reliable File Change, and Turn Diff output", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    const commandId = session.startCommandExecution("printf done", "/synthetic");
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).item !== undefined &&
        ((message.params as JsonObject).item as JsonObject).id === commandId,
    );
    session.appendCommandOutput(commandId, "done\n");
    await fixture.collector.waitFor((message) =>
      method(message, "item/commandExecution/outputDelta"),
    );
    session.completeItem(commandId, { status: "succeeded" });

    const toolId = session.startToolExecution("custom", { value: 1 });
    session.replaceToolOutput(toolId, {
      content: [{ type: "text", text: "custom output" }],
    });
    session.completeItem(toolId, { status: "succeeded" });
    const toolCompleted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === toolId,
    );
    expect(toolCompleted).toMatchObject({
      params: { item: { type: "dynamicToolCall", tool: "custom", success: true } },
    });

    session.emitFileChange([
      {
        path: "sample.txt",
        kind: "update",
        unifiedDiff: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-old\n+new\n",
      },
    ]);
    await fixture.collector.waitFor((message) => method(message, "item/fileChange/patchUpdated"));
    await expect(
      fixture.collector.waitFor((message) => method(message, "turn/diff/updated")),
    ).resolves.toMatchObject({ params: { diff: expect.stringContaining("+new") } });

    session.appendText("finished");
    session.succeedTurn();
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({
      params: {
        turn: {
          status: "completed",
          items: [{ type: "agentMessage" }],
        },
      },
    });
    await stopFixture(fixture);
  });

  it("round-trips an early Approval through the reviewed Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApprovalOnNextTurn("Allow native action?", "One-shot approval");

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toEqual({
      id: -1_000_001,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "Pi",
        threadId,
        turnId,
        mode: "form",
        message: "Allow native action?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          reason: "One-shot approval",
        },
      },
    });
    expect(
      fixture.collector.messages.some((message) => method(message, "item/tool/requestUserInput")),
    ).toBe(false);

    const approvalRequestId = request.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept", content: {}, _meta: null },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowOnce" } },
      ]);
    });
    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.interactionResponses).toHaveLength(1);

    session.appendText("continued");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("round-trips a declared native Approval scope without exposing a payload", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.requestApproval("Remember native action?", undefined, "always");
    const request = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    expect(request).toMatchObject({ params: { _meta: { persist: "always" } } });
    if (typeof request.id !== "number") throw new Error("Approval request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { action: "accept", content: {}, _meta: { persist: "always" } },
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses).toMatchObject([
        { response: { type: "approval", actionId: "allowAlways" } },
      ]);
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("fails closed for denied, cancelled, errored, and malformed native Approval responses", async () => {
    const responses: JsonObject[] = [
      { result: { action: "decline" } },
      { result: { action: "cancel" } },
      { error: { code: -1, message: "dismissed" } },
      { result: { action: "allowForSession" } },
      { result: { action: "accept", content: {}, _meta: { persist: "session" } } },
    ];
    for (const response of responses) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.requestApproval("Approve once");
      const request = await fixture.collector.waitFor((message) =>
        method(message, "mcpServer/elicitation/request"),
      );
      const approvalRequestId = request.id;
      if (typeof approvalRequestId !== "number") {
        throw new Error("Approval request has no numeric Host ID");
      }
      writeRequest(fixture.desktopInput, { id: approvalRequestId, ...response });
      await vi.waitFor(() => {
        expect(session.interactionResponses.at(-1)).toMatchObject({
          response: { type: "approval", actionId: "deny" },
        });
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("resolves cancelled Approval state and consumes its reserved late-response namespace", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.requestApproval("Cancel pending Approval");
    const approvalRequest = await fixture.collector.waitFor((message) =>
      method(message, "mcpServer/elicitation/request"),
    );
    const approvalRequestId = approvalRequest.id;
    if (typeof approvalRequestId !== "number") {
      throw new Error("Approval request has no numeric Host ID");
    }
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await fixture.collector.waitFor((message) => requestId(message, 3));
    const resolved = await fixture.collector.waitFor((message) =>
      method(message, "serverRequest/resolved"),
    );
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(resolved).toMatchObject({
      params: { threadId, requestId: approvalRequestId },
    });
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const resolvedIndex = fixture.collector.messages.indexOf(resolved);
    const terminalIndex = fixture.collector.messages.indexOf(completed);
    expect(resolvedIndex).toBeGreaterThan(responseIndex);
    expect(terminalIndex).toBeGreaterThan(resolvedIndex);

    writeRequest(fixture.desktopInput, {
      id: approvalRequestId,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, {
      id: -1_500_000,
      result: { action: "accept" },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).toContain(JSON.stringify({ id: 999, result: { official: true } }));
    expect(forwarded.join("")).not.toContain(String(approvalRequestId));
    expect(forwarded.join("")).not.toContain("-1500000");
    expect(session.interactionResponses).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("round-trips an early standalone Question through the Codex native request", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.askQuestionOnNextTurn(
      {
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [
          { value: "continue-value", label: "Continue" },
          { value: "stop-value", label: "Stop" },
        ],
        multiple: false,
        allowOther: false,
        optional: false,
      },
      { title: "Decision" },
    );

    const turnId = await startPiTurn(fixture, threadId);
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    expect(request).toMatchObject({
      id: -1,
      params: {
        threadId,
        turnId,
        itemId: expect.any(String),
        questions: [
          {
            id: "decision",
            header: "Decision",
            question: "Choose",
            options: [
              { label: "Continue", description: "" },
              { label: "Stop", description: "" },
            ],
          },
        ],
      },
    });
    const turnResponseIndex = fixture.collector.messages.findIndex((message) =>
      requestId(message, 2),
    );
    const questionIndex = fixture.collector.messages.indexOf(request);
    expect(questionIndex).toBeGreaterThan(turnResponseIndex);
    const requestIdValue = request.id;
    if (typeof requestIdValue !== "number") throw new Error("Question request has no numeric ID");
    writeRequest(fixture.desktopInput, {
      id: requestIdValue,
      result: { answers: { decision: { answers: ["Continue"] } } },
    });
    await fixture.collector.waitFor(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id ===
          (request.params as JsonObject).itemId,
    );
    expect(session.interactionResponses).toMatchObject([
      {
        response: { type: "question", answers: { decision: ["continue-value"] } },
      },
    ]);

    session.appendText("continued");
    session.succeedTurn();
    await fixture.collector.waitFor((message) => turnEvent(message, "turn/completed", turnId));
    await stopFixture(fixture);
  });

  it("fails a secret Question closed without rendering visible Desktop input", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion({
      id: "secret",
      type: "text",
      prompt: "Secret value",
      multiline: false,
      secret: true,
      optional: false,
    });
    await vi.waitFor(() => {
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
    });
    expect(
      fixture.collector.messages.filter((message) => method(message, "item/tool/requestUserInput")),
    ).toHaveLength(0);
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("cancels malformed and dismissed Desktop Question responses", async () => {
    for (const result of [
      { answers: { decision: { answers: ["undeclared"] } } },
      { answers: {} },
    ]) {
      const fixture = createFixture();
      const threadId = await startPiThread(fixture);
      const session = fixture.adapter.sessions[0];
      if (!session) throw new Error("Fake Pi Session was not opened");
      await startPiTurn(fixture, threadId);
      session.askQuestion({
        id: "decision",
        type: "choice",
        prompt: "Choose",
        options: [{ value: "known", label: "Known" }],
        multiple: false,
        allowOther: false,
        optional: false,
      });
      const request = await fixture.collector.waitFor((message) =>
        method(message, "item/tool/requestUserInput"),
      );
      if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
      writeRequest(fixture.desktopInput, { id: request.id, result });
      await fixture.collector.waitFor((message) => method(message, "item/completed"));
      expect(session.interactionResponses.at(-1)).toMatchObject({
        response: { type: "question", answers: {}, cancelled: true },
      });
      session.succeedTurn();
      await fixture.collector.waitFor((message) => method(message, "turn/completed"));
      await stopFixture(fixture);
    }
  });

  it("cancels a Question at the Host expiry bound", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    session.askQuestion(
      {
        id: "value",
        type: "text",
        prompt: "Value",
        multiline: false,
        secret: false,
        optional: false,
      },
      { expiresAt: new Date(Date.now() + 20).toISOString() },
    );
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));
    expect(session.interactionResponses.at(-1)).toMatchObject({
      response: { type: "question", answers: {}, cancelled: true },
    });
    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("forwards non-Host responses and consumes retired Host Question responses", async () => {
    const fixture = createFixture();
    const forwarded: string[] = [];
    fixture.official.stdin.setEncoding("utf8");
    fixture.official.stdin.on("data", (chunk: string) => forwarded.push(chunk));
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await startPiTurn(fixture, threadId);
    const interactionId = session.askQuestion({
      id: "value",
      type: "text",
      prompt: "Value",
      multiline: false,
      secret: false,
      optional: false,
    });
    const request = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    if (typeof request.id !== "number") throw new Error("Question request has no numeric ID");
    session.expireQuestion(interactionId);
    await expect(
      fixture.collector.waitFor((message) => method(message, "serverRequest/resolved")),
    ).resolves.toMatchObject({
      params: { threadId, requestId: request.id },
    });
    await fixture.collector.waitFor((message) => method(message, "item/completed"));

    writeRequest(fixture.desktopInput, {
      id: request.id,
      result: { answers: { value: { answers: ["late"] } } },
    });
    writeRequest(fixture.desktopInput, { id: 999, result: { official: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(forwarded.join("")).toContain(JSON.stringify({ id: 999, result: { official: true } }));
    expect(forwarded.join("")).not.toContain(String(request.id));

    session.succeedTurn();
    await fixture.collector.waitFor((message) => method(message, "turn/completed"));
    await stopFixture(fixture);
  });

  it("writes the interrupt response before cancellation lifecycle notifications", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    session.startCommandExecution("sleep 10");
    session.askQuestion({
      id: "cancel-decision",
      type: "choice",
      prompt: "Continue?",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      multiple: false,
      allowOther: false,
      optional: false,
    });
    const questionRequest = await fixture.collector.waitFor((message) =>
      method(message, "item/tool/requestUserInput"),
    );
    session.completeCancellationOnRequest();

    writeRequest(fixture.desktopInput, {
      id: 3,
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 3))).resolves.toEqual({
      id: 3,
      result: {},
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({ params: { turn: { status: "interrupted" } } });

    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 3));
    const questionItemId = (questionRequest.params as JsonObject).itemId;
    const questionClosedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "item/completed") &&
        ((message.params as JsonObject).item as JsonObject | undefined)?.id === questionItemId,
    );
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(questionClosedIndex).toBeGreaterThan(responseIndex);
    expect(turnIndex).toBeGreaterThan(questionClosedIndex);
    await stopFixture(fixture);
  });

  it("rejects an interrupt that does not reference the active Pi Turn", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);
    const threadId = await startPiThread(fixture);

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/interrupt",
      params: { threadId, turnId: "missing-turn" },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 2)),
    ).resolves.toMatchObject({
      error: { code: -32074, message: "External turn/interrupt must reference the active Turn" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    await stopFixture(fixture);
  });

  it("isolates Pi and Claude Threads behind the same registered Harness path", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const claudeThreadId = await startExternalThread(
      fixture,
      CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
      10,
    );
    const piThreadId = await startExternalThread(fixture, "codexhost/pi-native", 11);
    expect(claudeThreadId).not.toBe(piThreadId);
    expect(claudeAdapter.sessions).toHaveLength(1);
    expect(piAdapter.sessions).toHaveLength(1);

    writeRequest(fixture.desktopInput, {
      id: 12,
      method: "turn/start",
      params: { threadId: claudeThreadId, input: [{ type: "text", text: "synthetic" }] },
    });
    await fixture.collector.waitFor((message) => requestId(message, 12));
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.appendText("claude output");
    const claudeStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(claudeStarted).toBeDefined();
    claudeSession.succeedTurn();
    await fixture.collector.waitFor(
      (message) =>
        method(message, "turn/completed") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );

    expect(piAdapter.sessions[0]?.initialState.effectiveModel).toEqual(
      piAdapter.catalog.defaultModel,
    );
    expect(claudeAdapter.sessions).toHaveLength(1);
    const responseIndex = fixture.collector.messages.findIndex((message) => requestId(message, 12));
    const startedIndex = fixture.collector.messages.findIndex(
      (message) =>
        method(message, "turn/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(startedIndex).toBeGreaterThan(responseIndex);
    await stopFixture(fixture);
  });

  it("keeps selected Claude Models request-scoped and projects confirmed actual state", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const firstModel = claudeAdapter.catalog.models[0]?.ref;
    const secondModel = claudeAdapter.catalog.models[1]?.ref;
    if (!firstModel || !secondModel) throw new Error("Fake Claude catalog is incomplete");

    const firstThreadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(secondModel),
      20,
    );
    const secondThreadId = await startExternalThread(
      fixture,
      encodeClaudeTransportModel(firstModel),
      21,
    );
    expect(claudeAdapter.sessions[0]?.initialState.effectiveModel).toEqual(secondModel);
    expect(claudeAdapter.sessions[1]?.initialState.effectiveModel).toEqual(firstModel);

    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "codexhost/thread/model/select",
      params: { threadId: firstThreadId, model: firstModel },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 22)),
    ).resolves.toMatchObject({
      result: {
        effectiveModel: firstModel,
        resolvedModelLabel: "fake-runtime-primary",
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 23,
      method: "codexhost/thread/inspect",
      params: { threadId: firstThreadId },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 23)),
    ).resolves.toMatchObject({
      result: {
        harnessId: "claude-code",
        transportModelId: encodeClaudeTransportModel(secondModel),
        effectiveModel: firstModel,
        resolvedModelLabel: "fake-runtime-primary",
      },
    });

    writeRequest(fixture.desktopInput, {
      id: 24,
      method: "turn/start",
      params: {
        threadId: secondThreadId,
        model: encodePiTransportModel(piAdapter.catalog.defaultModel),
        input: [{ type: "text", text: "foreign" }],
      },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 24)),
    ).resolves.toMatchObject({
      error: {
        code: -32602,
        message: "Turn Model carrier does not belong to the Thread Harness",
      },
    });
    expect(claudeAdapter.sessions[1]?.state.effectiveModel).toEqual(firstModel);
    await stopFixture(fixture);
  });

  it("rejects Model selection when the owning Claude Session does not support it", async () => {
    const piAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const claudeAdapter = new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"));
    const fixture = createFixture({
      externalAdapters: new Map<ExternalHarnessId, FakeHarnessAdapter>([
        ["pi", piAdapter],
        ["claude-code", claudeAdapter],
      ]),
    });
    const threadId = await startExternalThread(fixture, CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, 20);
    const model = piAdapter.catalog.defaultModel;
    if (!model) throw new Error("Fake Pi catalog has no default Model");
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.capabilities.configuration.selectModel = false;

    writeRequest(fixture.desktopInput, {
      id: 21,
      method: "codexhost/thread/model/select",
      params: { threadId, model },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 21)),
    ).resolves.toMatchObject({
      error: {
        code: -32078,
        message: "External Harness does not support Model selection",
      },
    });
    expect(claudeSession.state.effectiveModel).toEqual(claudeAdapter.catalog.defaultModel);

    const off = claudeAdapter.catalog.thinkingOptions.find(({ id }) => id === "off")?.id;
    if (!off) throw new Error("Fake Claude catalog has no Thinking option");
    claudeSession.capabilities.configuration.selectThinkingOption = false;
    writeRequest(fixture.desktopInput, {
      id: 22,
      method: "codexhost/thread/thinking/select",
      params: { threadId, thinkingOptionId: off },
    });
    await expect(
      fixture.collector.waitFor((message) => requestId(message, 22)),
    ).resolves.toMatchObject({
      error: {
        code: -32078,
        message: "External Harness does not support Thinking selection",
      },
    });
    await stopFixture(fixture);
  });

  it("fails closed when a valid Claude token has no registered Adapter", async () => {
    const fixture = createFixture();
    const officialWrite = vi.fn();
    fixture.official.stdin.on("data", officialWrite);

    writeRequest(fixture.desktopInput, {
      id: 20,
      method: "thread/start",
      params: { model: CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID, cwd: "/synthetic" },
    });

    await expect(
      fixture.collector.waitFor((message) => requestId(message, 20)),
    ).resolves.toMatchObject({
      error: { code: -32070, message: "External Harness 'claude-code' is unavailable" },
    });
    expect(officialWrite).not.toHaveBeenCalled();
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("does not pass internal Harness controls to the official app-server", async () => {
    const fixture = createFixture({
      environment: {
        VISIBLE_TO_OFFICIAL: "yes",
        CODEXHOST_DATA_DIR: "/synthetic/codexhost-data",
        CODEXHOST_ENABLE_CLAUDE_CODE: "1",
        CODEXHOST_CLAUDE_COMMAND: "/synthetic/claude",
        CODEXHOST_PI_COMMAND: "/synthetic/pi",
      },
    });

    await vi.waitFor(() => {
      expect(fixture.spawnOfficial).toHaveBeenCalledWith(
        "/synthetic/codex",
        ["app-server"],
        expect.objectContaining({ env: { VISIBLE_TO_OFFICIAL: "yes" } }),
      );
    });
    await stopFixture(fixture);
  });

  it("forwards a Codex-owned interrupt without invoking Pi", async () => {
    const fixture = createFixture();
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });

    writeRequest(fixture.desktopInput, {
      id: 8,
      method: "turn/interrupt",
      params: { threadId: "official-thread", turnId: "official-turn" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: {},
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned history pagination without opening a Pi Session", async () => {
    const fixture = createFixture();
    const request = {
      id: 8,
      method: "thread/turns/list",
      params: {
        threadId: "official-thread",
        cursor: "official-cursor",
        limit: 7,
        sortDirection: "desc",
        itemsView: "summary",
        extraOfficialField: { keep: true },
      },
    };
    const forwarded = new Promise<JsonObject>((resolve) => {
      fixture.official.stdin.once("data", (chunk: Buffer) => {
        const value = JSON.parse(chunk.toString("utf8")) as JsonObject;
        resolve(value);
        fixture.official.stdout.write(`${JSON.stringify({ id: 8, result: { data: [] } })}\n`);
      });
    });

    writeRequest(fixture.desktopInput, request);
    await expect(forwarded).resolves.toEqual(request);
    await expect(fixture.collector.waitFor((message) => requestId(message, 8))).resolves.toEqual({
      id: 8,
      result: { data: [] },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards official Codex Usage notifications without external projection", async () => {
    const fixture = createFixture();
    const notification = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "official-thread",
        turnId: "official-turn",
        tokenUsage: {
          total: {
            totalTokens: 11,
            inputTokens: 5,
            cachedInputTokens: 1,
            cacheWriteInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 4,
            inputTokens: 4,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 100,
        },
      },
    };
    fixture.official.stdout.write(`${JSON.stringify(notification)}\n`);

    await expect(
      fixture.collector.waitFor((message) => method(message, "thread/tokenUsage/updated")),
    ).resolves.toEqual(notification);
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });

  it("forwards Codex-owned requests without opening a Pi Session", async () => {
    const fixture = createFixture();
    fixture.official.stdin.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as JsonObject;
      fixture.official.stdout.write(
        `${JSON.stringify({ id: request.id, result: { source: "official" } })}\n`,
      );
    });

    writeRequest(fixture.desktopInput, {
      id: 9,
      method: "thread/read",
      params: { threadId: "official-thread" },
    });
    await expect(fixture.collector.waitFor((message) => requestId(message, 9))).resolves.toEqual({
      id: 9,
      result: { source: "official" },
    });
    expect(fixture.adapter.sessions).toHaveLength(0);
    await stopFixture(fixture);
  });
});
