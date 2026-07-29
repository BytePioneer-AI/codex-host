import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  CLAUDE_CODE_NATIVE_TRANSPORT_MODEL_ID,
  encodePiTransportModel,
  type ExternalHarnessId,
  type JsonObject,
} from "@codexhost/protocol-core";
import { harnessIdSchema } from "@codexhost/shared-contracts";

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
  } = {},
) {
  const adapter =
    options.externalAdapters?.get("pi") ?? new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
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
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.externalAdapters
      ? { externalAdapters: options.externalAdapters }
      : { piAdapter: adapter }),
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

async function stopFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.desktopInput.end();
  await expect(fixture.running).resolves.toBe(0);
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
        capabilities: { configuration: { selectModel: true } },
      },
    });
    expect(fixture.adapter.inspectionCalls).toBe(1);
    expect(fixture.adapter.sessions).toHaveLength(0);
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
    await expect(fixture.collector.waitFor((message) => requestId(message, 31))).resolves.toEqual({
      id: 31,
      result: { effectiveModel: model },
    });
    expect(fixture.adapter.sessions[0]?.state.effectiveModel).toEqual(model);
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
    fixture.adapter.sessions[0]?.succeedTurn();
    await stopFixture(fixture);
  });

  it("binds a selected Pi Model carrier to create and later Turn routing", async () => {
    const fixture = createFixture();
    const model = fixture.adapter.catalog.models[1]?.ref;
    if (!model) throw new Error("Fake catalog has no secondary Model");
    const carrier = encodePiTransportModel(model);
    const threadId = await startPiThread(fixture, carrier);

    expect(fixture.adapter.sessions[0]?.initialState.effectiveModel).toEqual(model);
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
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.appendText("fake output");
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

  it("projects Item completion before a failed Turn terminal", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");

    writeRequest(fixture.desktopInput, {
      id: 2,
      method: "turn/start",
      params: { threadId, input: [{ type: "text", text: "failed" }] },
    });
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.failTurn({
      code: "nativeFailure",
      message: "synthetic native failure",
      retryable: false,
    });
    const completed = await fixture.collector.waitFor((message) =>
      method(message, "turn/completed"),
    );
    expect(completed).toMatchObject({ params: { turn: { status: "failed" } } });

    const itemIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "item/completed"),
    );
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThan(itemIndex);
    await stopFixture(fixture);
  });

  it("projects Command, Generic Tool, reliable File Change, and Turn Diff output", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => method(message, "item/started"));

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

  it("writes the interrupt response before cancellation lifecycle notifications", async () => {
    const fixture = createFixture();
    const threadId = await startPiThread(fixture);
    const turnId = await startPiTurn(fixture, threadId);
    const session = fixture.adapter.sessions[0];
    if (!session) throw new Error("Fake Pi Session was not opened");
    await fixture.collector.waitFor((message) => method(message, "item/started"));
    session.startCommandExecution("sleep 10");
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
    const turnIndex = fixture.collector.messages.findIndex((message) =>
      method(message, "turn/completed"),
    );
    expect(turnIndex).toBeGreaterThan(responseIndex);
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
    const claudeStarted = await fixture.collector.waitFor(
      (message) =>
        method(message, "item/started") &&
        (message.params as JsonObject).threadId === claudeThreadId,
    );
    expect(claudeStarted).toBeDefined();
    const claudeSession = claudeAdapter.sessions[0];
    if (!claudeSession) throw new Error("Fake Claude Session was not opened");
    claudeSession.appendText("claude output");
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

  it("rejects Pi Model selection for a Claude-owned Thread", async () => {
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
        message: "Model selection requires a current-process Pi Thread",
      },
    });
    expect(claudeAdapter.sessions[0]?.state.effectiveModel).toEqual(
      claudeAdapter.catalog.defaultModel,
    );
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
        CODEXHOST_ENABLE_CLAUDE_CODE: "1",
        CODEXHOST_CLAUDE_COMMAND: "/synthetic/claude",
        CODEXHOST_PI_COMMAND: "/synthetic/pi",
      },
    });

    expect(fixture.spawnOfficial).toHaveBeenCalledWith(
      "/synthetic/codex",
      ["app-server"],
      expect.objectContaining({ env: { VISIBLE_TO_OFFICIAL: "yes" } }),
    );
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
