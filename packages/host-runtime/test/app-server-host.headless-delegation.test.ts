import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { MappingStore } from "@codexhost/mapping-store";
import type { JsonObject } from "@codexhost/protocol-core";
import { AppServerHost } from "../src/app-server-host.js";
import { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import type { OfficialAppServerExit } from "../src/official-app-server-connection.js";
import { JsonLineCollector } from "./app-server-host-fixture.js";

it("initializes a headless client's first default-model Codex delegation and exports its full Thread", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "headless-delegation-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  const registration = Promise.withResolvers<DelegationControlRegistration>();
  const requests = new JsonLineCollector(stdin);
  const methods: string[] = [];
  let initialized = false;
  const turns = [
    {
      id: "native-turn",
      status: "inProgress",
      items: [
        { type: "reasoning", summary: ["native reasoning"] },
        { type: "commandExecution", command: "ls", aggregatedOutput: "native tool output" },
      ],
    },
  ];
  const threadReads: unknown[] = [];
  stdin.on("data", () => {
    for (const request of requests.messages.splice(0)) {
      methods.push(String(request.method));
      if (request.id === undefined) continue;
      let response: JsonObject;
      if (request.method === "initialize") {
        initialized = true;
        response = { result: { userAgent: "fixture" } };
      } else if (!initialized) {
        response = { error: { code: -32002, message: "Not initialized" } };
      } else if (request.method === "thread/start") {
        response = { result: { thread: { id: "native-child" } } };
      } else if (request.method === "thread/read") {
        threadReads.push(request.params);
        response = {
          result: {
            thread: {
              id: "native-child",
              cwd: directory,
              title: "Native",
              status: { type: "active" },
              turns,
            },
          },
        };
      } else if (request.method === "turn/start") {
        response = { result: { turn: { id: "native-turn" } } };
      } else {
        response = { result: {} };
      }
      stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
    }
  });
  const connection = {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close() {
      stdout.end();
      closed.resolve({ code: 0, signal: null });
    },
  };
  const scope = new OfficialRuntimeScope({
    permanentHome: directory,
    diagnosticOutput: stderr,
    createBackend: () => ({
      closed: closed.promise,
      start: async () => {},
      connect: async () => connection,
      stop: async () => connection.close(),
    }),
  });
  await scope.start();
  const mappingStore = new MappingStore({ directory });
  await mappingStore.initialize();
  const host = new AppServerHost({
    externalOnly: true,
    stockCodexPath: "/unused",
    arguments: [],
    desktopInput: new PassThrough(),
    desktopOutput: new PassThrough(),
    diagnosticOutput: new PassThrough(),
    environment: { CODEXHOST_DATA_DIR: directory },
    mappingStore,
    officialRuntimeScope: scope,
    externalAdapters: new Map(),
    onDelegationApi: (api) => {
      registration.resolve(api);
      return undefined;
    },
  });
  const running = host.run();
  try {
    const api = await registration.promise;
    await expect(
      api.start({
        harnessId: "codex",
        task: "inspect workspace",
        cwd: directory,
        parentThreadId: "client:grokbot-user",
        requestId: "headless-first",
      }),
    ).resolves.toMatchObject({
      threadId: "native-child",
      turnId: "native-turn",
      status: "running",
    });
    const exported = await api.exportThread?.({ threadId: "native-child" });
    expect(exported).toMatchObject({
      threadId: "native-child",
      harnessId: "codex",
      turns: 1,
      complete: false,
    });
    if (!exported) throw new Error("Export unavailable");
    const document = JSON.parse(readFileSync(exported.path, "utf8"));
    expect(document.thread).toMatchObject({
      id: "native-child",
      harnessId: "codex",
      cwd: directory,
      title: "Native",
    });
    expect(document.turns).toEqual(turns);
    expect(threadReads).toContainEqual({ threadId: "native-child", includeTurns: true });
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
  } finally {
    host.close();
    await running;
    await scope.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("shares native question claims across a Desktop-owned API and the Web service", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "shared-native-questions-"));
  const backendExit = Promise.withResolvers<OfficialAppServerExit>();
  const connections: Array<{ stdout: PassThrough; close(): void }> = [];
  const deliveries: JsonObject[] = [];
  const threadId = "native-thread";
  const turnId = "native-turn";
  const questionId = JSON.stringify(["request_user_input_async", "question", 0]);
  const turns = [
    {
      id: turnId,
      status: "inProgress",
      items: [
        {
          id: "question",
          type: "agentMessage",
          delivery: "async",
          text: "",
          questions: [{ title: "Continue?", options: ["Continue", "Stop"] }],
        },
      ],
    },
  ];
  const thread = {
    id: threadId,
    cwd: directory,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "active" },
    turns,
  };
  let announced = false;
  const scope = new OfficialRuntimeScope({
    permanentHome: directory,
    diagnosticOutput: new PassThrough(),
    createBackend: () => ({
      closed: backendExit.promise,
      start: async () => {},
      connect: async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const exit = Promise.withResolvers<OfficialAppServerExit>();
        const requests = new JsonLineCollector(stdin);
        const connectionIndex = connections.length;
        const connection = {
          stdin,
          stdout,
          stderr,
          closed: exit.promise,
          close() {
            if (!stdout.writableEnded) stdout.end();
            exit.resolve({ code: 0, signal: null });
          },
        };
        connections.push(connection);
        stdin.on("data", () => {
          for (const request of requests.messages.splice(0)) {
            if (request.id === undefined) continue;
            if (request.method === "thread/read" && connectionIndex === 0 && !announced) {
              announced = true;
              stdout.write(
                `${JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } })}\n`,
              );
            }
            let result: JsonObject = {};
            if (request.method === "thread/read" || request.method === "thread/resume")
              result = { thread };
            else if (request.method === "thread/turns/list")
              result = { data: turns, nextCursor: null };
            else if (request.method === "thread/queue/list")
              result = { data: [], nextCursor: null };
            else if (request.method === "turn/steer") {
              deliveries.push(request);
              result = { turnId };
            }
            stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
          }
        });
        return connection;
      },
      stop: async () => {
        for (const connection of connections) connection.close();
        backendExit.resolve({ code: 0, signal: null });
      },
    }),
  });
  await scope.start();
  const mappingStore = new MappingStore({ directory });
  await mappingStore.initialize();
  const registration = Promise.withResolvers<DelegationControlRegistration>();
  const sharedRegistration = Promise.withResolvers<DelegationControlRegistration>();
  const common = {
    stockCodexPath: "/unused",
    arguments: [],
    environment: { HOME: directory, CODEX_HOME: directory, CODEXHOST_DATA_DIR: directory },
    mappingStore,
    closeMappingStoreOnExit: false,
    officialRuntimeScope: scope,
    externalAdapters: new Map(),
    diagnosticOutput: new PassThrough(),
  };
  const web = new AppServerHost({
    ...common,
    externalOnly: true,
    desktopInput: new PassThrough(),
    desktopOutput: new PassThrough(),
    onDelegationApi: (api) => {
      sharedRegistration.resolve(api);
      return undefined;
    },
  });
  const webRunning = web.run();
  const shared = await sharedRegistration.promise;
  const desktop = new AppServerHost({
    ...common,
    sharedDelegation: shared,
    desktopInput: new PassThrough(),
    desktopOutput: new PassThrough(),
    onDelegationApi: (api) => {
      registration.resolve(api);
      return undefined;
    },
  });
  const desktopRunning = desktop.run();
  const complete = () => {
    for (const connection of connections)
      if (!connection.stdout.writableEnded)
        connection.stdout.write(
          `${JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })}\n`,
        );
  };
  try {
    const api = await registration.promise;
    const pending = (await api.read({ threadId, view: "result" })).pendingQuestions?.[0];
    const snapshot = await web.clientSnapshot(threadId);
    const card = snapshot.interactions[0];
    if (!pending || !card) throw new Error("Missing native question");
    expect(await api.ownsThread(threadId)).toBe(true);
    expect(await shared.ownsThread(threadId)).toBe(false);
    expect(pending.interactionId).not.toBe(card.requestId);
    const answers = await Promise.allSettled([
      api.answer({
        threadId,
        interactionId: pending.interactionId,
        result: { answer: "Continue" },
      }),
      web.respondClient({
        epoch: web.clientEvents.epoch,
        threadId,
        requestId: card.requestId,
        result: { answers: { [questionId]: { answers: ["Stop"] } } },
      }),
    ]);
    expect(answers.some((answer) => answer.status === "fulfilled")).toBe(true);
    expect(deliveries).toHaveLength(1);
    complete();
    desktop.close();
    await desktopRunning;
    expect((await web.clientSnapshot(threadId)).interactions).toEqual([]);
  } finally {
    complete();
    desktop.close();
    web.close();
    await Promise.all([desktopRunning, webRunning]);
    await scope.close();
    await mappingStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
