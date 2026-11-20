import { mkdtempSync, rmSync } from "node:fs";
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

it("initializes a headless client's first default-model Codex delegation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "headless-delegation-"));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  const registration = Promise.withResolvers<DelegationControlRegistration>();
  const requests = new JsonLineCollector(stdin);
  const methods: string[] = [];
  let initialized = false;
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
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("thread/start"));
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
  } finally {
    host.close();
    await running;
    await scope.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
