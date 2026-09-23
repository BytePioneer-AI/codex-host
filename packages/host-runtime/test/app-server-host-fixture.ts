import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, vi } from "vitest";
import type {
  HarnessAdapter,
  HarnessResult,
  HarnessSessionState,
} from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { type ExternalHarnessId, type JsonObject } from "@codexhost/protocol-core";
import { harnessIdSchema, type DeepSeekModernSessionCandidate } from "@codexhost/shared-contracts";
import type { DelegationControlRegistration } from "../src/delegation-types.js";
import { AppServerHost } from "../src/app-server-host.js";
import type { CodexAccountControl } from "../src/account/codex-account-control.js";
import type { OfficialRuntimeScope } from "../src/codex-runtime/official-runtime-scope.js";
import type { OfficialAppServerConnection } from "../src/official-app-server-connection.js";
import type { HostUpdateCoordinator } from "../src/update-coordinator.js";

export class FakeOfficialProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.stdout.end();
    this.emit("exit", null, signal);
    return true;
  });

  constructor(exitOnInputEnd = true) {
    super();
    this.stdin.once("finish", () => {
      if (!exitOnInputEnd) return;
      this.stdout.end();
      this.emit("exit", 0, null);
    });
  }
}

export class FailingOwnershipMappingStore extends MappingStore {
  override getThread(): Promise<never> {
    return Promise.reject(new Error("Synthetic ownership read failure"));
  }
}

export class FailingArchiveMappingStore extends MappingStore {
  override setArchived(): Promise<never> {
    return Promise.reject(new Error("Synthetic archive write failure"));
  }
}

export class FailingListMappingStore extends MappingStore {
  override listThreads(): Promise<never> {
    return Promise.reject(new Error("Synthetic list read failure"));
  }
}

export class FailingDelegationMappingStore extends MappingStore {
  override createDelegation(): Promise<never> {
    return Promise.reject(new Error("Synthetic Delegation write failure"));
  }
}

export class JsonLineCollector {
  readonly messages: JsonObject[] = [];
  readonly #waiters: Array<{
    predicate: (message: JsonObject) => boolean;
    resolve(message: JsonObject): void;
    timeout: ReturnType<typeof setTimeout>;
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
        for (const waiter of matched) {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
        newline = this.#buffer.indexOf("\n");
      }
    });
  }

  waitFor(predicate: (message: JsonObject) => boolean): Promise<JsonObject> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("Timed out waiting for Host output"));
        }, 2_000),
      };
      this.#waiters.push(waiter);
    });
  }
}

export function method(message: JsonObject, value: string): boolean {
  return message.method === value;
}

export function requestId(message: JsonObject, id: number): boolean {
  return message.id === id;
}

export function requiredMessageId(message: JsonObject): string | number {
  if (typeof message.id === "string" || typeof message.id === "number") return message.id;
  throw new Error("JSON-RPC message has no ID");
}

export function messageParams(message: JsonObject): JsonObject {
  return (message.params ?? {}) as JsonObject;
}

export function threadStatus(message: JsonObject, threadId: string, type: string): boolean {
  const params = messageParams(message);
  return (
    method(message, "thread/status/changed") &&
    params.threadId === threadId &&
    (params.status as JsonObject | undefined)?.type === type
  );
}

export function turnEvent(message: JsonObject, eventMethod: string, turnId: string): boolean {
  const params = messageParams(message);
  return (
    method(message, eventMethod) &&
    ((params.turn as JsonObject | undefined)?.id === turnId || params.turnId === turnId)
  );
}

export function writeRequest(stream: PassThrough, value: JsonObject): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export const jsonLineBuffers = new WeakMap<PassThrough, string>();

export async function readJsonLine(stream: PassThrough): Promise<JsonObject> {
  let buffer = jsonLineBuffers.get(stream) ?? "";
  if (!buffer.includes("\n")) {
    await vi.waitFor(() => {
      const chunk = stream.read() as Buffer | string | null;
      if (chunk !== null) buffer += String(chunk);
      expect(buffer).toContain("\n");
    });
  }
  const newline = buffer.indexOf("\n");
  const line = buffer.slice(0, newline);
  jsonLineBuffers.set(stream, buffer.slice(newline + 1));
  return JSON.parse(line) as JsonObject;
}

export function rollbackCapableAdapter(): FakeHarnessAdapter {
  return new FakeHarnessAdapter(
    harnessIdSchema.parse("pi"),
    undefined,
    true,
    true,
    null,
    undefined,
    true,
  );
}

export class ResumeStateRollbackAdapter extends FakeHarnessAdapter {
  rollbackReplacementStateAtFirstRead: HarnessSessionState | undefined;

  override async open(input: Parameters<FakeHarnessAdapter["open"]>[0]) {
    const opened = await super.open(input);
    if (
      input.kind === "rollbackLastTurn" &&
      opened.ok &&
      opened.value instanceof FakeHarnessSession
    ) {
      const session = opened.value;
      const nativeRef = session.initialState.nativeRef;
      if (nativeRef) session.setStateForSnapshot({ nativeRef });
      const readSnapshot = session.readSnapshot.bind(session);
      session.readSnapshot = async () => {
        this.rollbackReplacementStateAtFirstRead ??= session.state;
        return readSnapshot();
      };
    }
    return opened;
  }
}

export class WebUiHarnessAdapter extends FakeHarnessAdapter {
  openCalls = 0;
  failureMessage: string | undefined;
  readonly webUi = {
    open: async (): Promise<HarnessResult<void>> => {
      this.openCalls += 1;
      return this.failureMessage
        ? {
            ok: false,
            error: {
              code: "unavailable",
              message: this.failureMessage,
              retryable: true,
            },
          }
        : { ok: true, value: undefined };
    },
  };
}

export class ModernSessionImportAdapter extends FakeHarnessAdapter {
  candidates: DeepSeekModernSessionCandidate[] = [];
  readonly listCandidates = vi.fn(
    async (): Promise<HarnessResult<DeepSeekModernSessionCandidate[]>> => ({
      ok: true,
      value: structuredClone(this.candidates),
    }),
  );
  readonly sessionImport = {
    listCandidates: this.listCandidates,
    resolveCandidate: async (nativeSessionId: string) => {
      const listed = await this.listCandidates();
      if (!listed.ok) return listed;
      const candidate = listed.value.find((entry) => entry.nativeSessionId === nativeSessionId);
      return candidate
        ? {
            ok: true as const,
            value: {
              candidate,
              nativeRef: { harnessId: this.harnessId, nativeSessionId, formatVersion: 1 as const },
            },
          }
        : {
            ok: false as const,
            error: {
              code: "sessionNotFound" as const,
              message: "Missing session",
              retryable: false,
            },
          };
    },
  };
}

export function createFixture(
  options: {
    environment?: NodeJS.ProcessEnv;
    pluginDirectory?: string;
    externalAdapters?: ReadonlyMap<ExternalHarnessId, FakeHarnessAdapter>;
    mappingStore?: MappingStore;
    mappingStoreDirectory?: string;
    closeMappingStoreOnExit?: boolean;
    desktopOutput?: PassThrough;
    officialExitsOnInputEnd?: boolean;
    createOfficialConnection?: () =>
      OfficialAppServerConnection | Promise<OfficialAppServerConnection>;
    updateCoordinator?: HostUpdateCoordinator;
    accountControl?: CodexAccountControl;
    officialRuntimeScope?: OfficialRuntimeScope;
    onDelegationApi?: (api: DelegationControlRegistration) => (() => void) | undefined;
  } = {},
) {
  const adapter =
    options.externalAdapters?.get("pi") ?? new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const mappingStoreDirectory =
    options.mappingStoreDirectory ?? mkdtempSync(path.join(tmpdir(), "codexhost-host-test-"));
  const mappingStore =
    options.mappingStore ?? new MappingStore({ directory: mappingStoreDirectory });
  const desktopInput = new PassThrough();
  const desktopOutput = options.desktopOutput ?? new PassThrough();
  const diagnosticOutput = new PassThrough();
  const official = new FakeOfficialProcess(options.officialExitsOnInputEnd);
  const collector = new JsonLineCollector(desktopOutput);
  const startup = Promise.withResolvers<undefined>();
  void startup.promise.catch(() => undefined);
  const spawnOfficial = vi.fn(() => {
    startup.resolve(undefined);
    return official as unknown as ChildProcessWithoutNullStreams;
  });
  const createOfficialConnection = options.createOfficialConnection;
  if (options.officialRuntimeScope) startup.resolve(undefined);
  const host = new AppServerHost({
    stockCodexPath: "/synthetic/codex",
    arguments: ["app-server"],
    defaultAgent: "codex",
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    mappingStore,
    ...(options.closeMappingStoreOnExit !== undefined
      ? { closeMappingStoreOnExit: options.closeMappingStoreOnExit }
      : {}),
    environment: {
      CODEXHOST_DATA_DIR: mappingStoreDirectory,
      ...(options.environment ?? {}),
    },
    ...(options.pluginDirectory ? { pluginRoots: [options.pluginDirectory] } : {}),
    externalAdapters:
      options.externalAdapters ?? new Map<ExternalHarnessId, HarnessAdapter>([["pi", adapter]]),
    spawnOfficial: spawnOfficial as unknown as typeof spawn,
    // The fake process exits synchronously on kill; real-time grace only slows tests.
    officialCloseTimeoutMs: 50,
    ...(createOfficialConnection
      ? {
          createOfficialConnection: async () => {
            startup.resolve(undefined);
            return createOfficialConnection();
          },
        }
      : {}),
    ...(options.updateCoordinator ? { updateCoordinator: options.updateCoordinator } : {}),
    ...(options.accountControl ? { accountControl: options.accountControl } : {}),
    ...(options.officialRuntimeScope ? { officialRuntimeScope: options.officialRuntimeScope } : {}),
    ...(options.onDelegationApi ? { onDelegationApi: options.onDelegationApi } : {}),
  });
  const running = host.run();
  void running.then(
    () => startup.reject(new Error("Host exited before fixture startup")),
    (error) => startup.reject(error),
  );
  return {
    adapter,
    collector,
    desktopInput,
    desktopOutput,
    diagnosticOutput,
    host,
    official,
    running,
    ready: startup.promise.then(
      () => new Promise<undefined>((resolve) => setImmediate(resolve, undefined)),
    ),
    mappingStore,
    mappingStoreDirectory,
    spawnOfficial,
  };
}

export async function startExternalThread(
  fixture: ReturnType<typeof createFixture>,
  model: string,
  id = 1,
  additionalParams: JsonObject = {},
): Promise<string> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id,
    method: "thread/start",
    params: { model, cwd: "/synthetic", ...additionalParams },
  });
  const response = await fixture.collector.waitFor((message) => requestId(message, id));
  expect(response).not.toHaveProperty("error");
  const result = response.result as JsonObject;
  const thread = result.thread as JsonObject;
  if (typeof thread.id !== "string") throw new Error("Synthetic thread response has no ID");
  return thread.id;
}

export async function startPiThread(
  fixture: ReturnType<typeof createFixture>,
  model = "codexhost/pi-native",
): Promise<string> {
  return startExternalThread(fixture, model);
}

export async function startPiTurn(
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

export async function completePiTurn(
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

export async function closeFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.desktopInput.end();
  const outcome = await fixture.running;
  expect(outcome, fixture.diagnosticOutput.read()?.toString() ?? "").toBe(0);
}

export async function stopFixture(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await closeFixture(fixture);
  rmSync(fixture.mappingStoreDirectory, { recursive: true, force: true });
}

export async function bindOfficialThread(
  fixture: ReturnType<typeof createFixture>,
  threadId: string,
): Promise<void> {
  void threadId;
  await fixture.ready;
  await vi.waitFor(() => expect(fixture.spawnOfficial).toHaveBeenCalledOnce());
}

export async function answerOfficialParentCwd(
  fixture: ReturnType<typeof createFixture>,
  threadId = "parent-thread",
): Promise<void> {
  const request = await readJsonLine(fixture.official.stdin);
  expect(request).toMatchObject({ method: "thread/read", params: { threadId } });
  fixture.official.stdout.write(
    `${JSON.stringify({
      id: request.id,
      result: { thread: { id: threadId, cwd: "/synthetic" } },
    })}\n`,
  );
}
