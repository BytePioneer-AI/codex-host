import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { PiAdapter } from "@codexhost/adapter-pi";
import type { HarnessAdapter, HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, type HostTurnId } from "@codexhost/shared-contracts";
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  CodexTurnProjector,
  decodeCreateRoute,
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  type JsonObject,
  type JsonRpcRequest,
  type JsonValue,
  type ProjectableHostEvent,
} from "@codexhost/protocol-core";

export interface AppServerHostOptions {
  stockCodexPath: string;
  arguments: string[];
  defaultAgent: "codex" | "pi";
  environment?: NodeJS.ProcessEnv;
  desktopInput?: Readable;
  desktopOutput?: Writable;
  diagnosticOutput?: Writable;
  piCommand?: string;
  piAdapter?: HarnessAdapter;
  spawnOfficial?: typeof spawn;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
}

interface TurnProjectionGate {
  promise: Promise<void>;
  resolve(): void;
}

interface ProjectedTurn {
  projector: CodexTurnProjector;
}

type PiThreadStatus = { type: "active"; activeFlags: [] } | { type: "idle" };

interface PiThread {
  id: string;
  cwd: string;
  session: HarnessSession;
  outputTask: Promise<void>;
  thread: JsonObject;
  turns: JsonObject[];
  running: boolean;
  activeTurnId: HostTurnId | null;
  projectedTurns: Map<HostTurnId, ProjectedTurn>;
  responseGates: Map<HostTurnId, TurnProjectionGate>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function officialEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const internal = new Set([
    "CODEX_CLI_PATH",
    "CODEXHOST_HOST_NODE_PATH",
    "CODEXHOST_DEFAULT_AGENT",
    "CODEXHOST_HOST_RUNTIME_PATH",
    "CODEXHOST_PI_COMMAND",
    "CODEXHOST_STOCK_CODEX_PATH",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !internal.has(key)));
}

function rpcEnvelope(request: JsonRpcRequest, value: JsonObject): JsonObject {
  return {
    ...(request.jsonrpc === "2.0" ? { jsonrpc: "2.0" } : {}),
    id: request.id,
    ...value,
  };
}

function rpcError(request: JsonRpcRequest, code: number, message: string): JsonObject {
  return rpcEnvelope(request, { error: { code, message } });
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function classifyCreateRequestRoute(
  request: JsonRpcRequest,
  defaultAgent: "codex" | "pi",
): CreateRequestRouteObservation | null {
  const route = decodeCreateRoute(request);
  if (!route) return null;
  if (route.harnessId === "pi") {
    return {
      requestMethod: "thread/start",
      modelCarrier: "pi-transport",
      selectedHarness: "pi",
      selectionSource: "transport-model",
    };
  }
  return {
    requestMethod: "thread/start",
    modelCarrier: "official-model",
    selectedHarness: defaultAgent,
    selectionSource: defaultAgent === "pi" ? "default-agent" : "official-model",
  };
}

function requestObject(request: JsonRpcRequest): JsonObject {
  if (!isRecord(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params as JsonObject;
}

function requestText(params: JsonObject): string {
  if (!Array.isArray(params.input)) throw new Error("turn/start input must be an array");
  const text = params.input
    .filter((item): item is JsonObject => isRecord(item) && item.type === "text")
    .map((item) => item.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (!text) throw new Error("turn/start must contain text input");
  return text;
}

function sandboxResult(params: JsonObject): JsonObject {
  const sandbox = params.sandbox;
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: [],
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function turnProjectionGate(): TurnProjectionGate {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class OrderedWriter {
  #tail = Promise.resolve();

  constructor(private readonly stream: Writable) {}

  frame(frame: Buffer<ArrayBufferLike>): Promise<void> {
    return this.#enqueue(() => writeFrame(this.stream, frame));
  }

  json(value: JsonValue): Promise<void> {
    return this.#enqueue(() => writeJsonFrame(this.stream, value));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export class AppServerHost {
  readonly #options: Required<
    Pick<AppServerHostOptions, "desktopInput" | "desktopOutput" | "diagnosticOutput">
  > &
    AppServerHostOptions;
  #official: ChildProcessWithoutNullStreams | null = null;
  #piAdapter: HarnessAdapter;
  #piThreads = new Map<string, PiThread>();
  #routeObservationTracker = new RequestRouteObservationTracker();
  #writer: OrderedWriter;

  constructor(options: AppServerHostOptions) {
    this.#options = {
      desktopInput: process.stdin,
      desktopOutput: process.stdout,
      diagnosticOutput: process.stderr,
      ...options,
    };
    this.#writer = new OrderedWriter(this.#options.desktopOutput);
    this.#piAdapter =
      options.piAdapter ??
      new PiAdapter({
        ...(options.piCommand ? { command: options.piCommand } : {}),
        environment: options.environment ?? process.env,
      });
  }

  async run(): Promise<number> {
    const spawnOfficial = this.#options.spawnOfficial ?? spawn;
    const official = spawnOfficial(this.#options.stockCodexPath, this.#options.arguments, {
      env: officialEnvironment(this.#options.environment ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    official.stderr.pipe(this.#options.diagnosticOutput, { end: false });
    this.#official = official;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        official.once("error", reject);
        official.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    try {
      await Promise.all([this.#forwardDesktop(), this.#forwardOfficial()]);
      const result = await exited;
      if (result.signal) throw new Error(`official app-server exited by signal ${result.signal}`);
      return result.code ?? 1;
    } catch (error) {
      this.#diagnose(error);
      official.stdin.destroy();
      official.kill("SIGTERM");
      await exited.catch(() => undefined);
      return 1;
    } finally {
      const threads = [...this.#piThreads.values()];
      await Promise.allSettled(threads.map(({ session }) => session.close()));
      await Promise.allSettled(threads.map(({ outputTask }) => outputTask));
      await this.#piAdapter.close().catch(() => undefined);
      this.#piThreads.clear();
      this.#routeObservationTracker.clear();
    }
  }

  async #forwardDesktop(): Promise<void> {
    const official = this.#official;
    if (!official) throw new Error("official app-server is unavailable");
    for await (const frame of readLfFrames(this.#options.desktopInput)) {
      const parsed = parseJsonFrame(frame);
      const requestResult = jsonRpcRequestSchema.safeParse(parsed);
      if (!requestResult.success) {
        await writeFrame(official.stdin, frame);
        continue;
      }
      const request = requestResult.data;
      const createRoute = classifyCreateRequestRoute(request, this.#options.defaultAgent);
      if (createRoute) {
        this.#options.onCreateRequestRoute?.(createRoute);
        this.#options.onRequestRoute?.(
          this.#routeObservationTracker.registerCreate(
            request.id,
            createRoute,
            classifyThreadPurpose(request),
          ),
        );
      }
      if (createRoute?.selectedHarness === "pi") {
        await this.#startPiThread(request);
        continue;
      }
      if (request.method === "turn/start") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (typeof threadId === "string") {
          this.#options.onRequestRoute?.(
            this.#routeObservationTracker.observeTurn(threadId, piThread ? "pi" : "codex"),
          );
        }
        if (piThread) {
          await this.#startPiTurn(request, piThread);
          continue;
        }
      }
      if (request.method === "turn/interrupt") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (piThread) {
          await this.#interruptPiTurn(request, piThread, params.turnId);
          continue;
        }
      }
      if (request.method === "thread/read") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (piThread) {
          await this.#readPiThread(request, piThread, params.includeTurns === true);
          continue;
        }
      }
      if (request.method === "thread/name/set") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (piThread) {
          await this.#setPiThreadName(request, piThread, params.name);
          continue;
        }
      }
      if (request.method === "thread/delete") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (piThread) {
          await this.#deletePiThread(request, piThread);
          continue;
        }
      }
      await writeFrame(official.stdin, frame);
    }
    official.stdin.end();
  }

  async #forwardOfficial(): Promise<void> {
    const official = this.#official;
    if (!official) throw new Error("official app-server is unavailable");
    for await (const frame of readLfFrames(official.stdout)) {
      const parsed = parseJsonFrame(frame);
      this.#routeObservationTracker.bindOfficialResponse(parsed);
      await this.#writer.frame(frame);
    }
  }

  async #startPiThread(request: JsonRpcRequest): Promise<void> {
    const params = requestObject(request);
    const cwd = params.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      await this.#writer.json(rpcError(request, -32602, "Pi thread/start requires cwd"));
      return;
    }
    const sessionResult = await this.#piAdapter.open({ kind: "create", cwd });
    if (!sessionResult.ok) {
      await this.#writer.json(rpcError(request, -32071, sessionResult.error.message));
      return;
    }
    const session = sessionResult.value;
    const threadId = randomUUID();
    this.#routeObservationTracker.bindCreatedThread(request.id, threadId);
    try {
      const now = unixSeconds();
      const thread: JsonObject = {
        id: threadId,
        sessionId: threadId,
        path: null,
        cwd,
        source: "appServer",
        threadSource: null,
        modelProvider: "codexhost",
        cliVersion: "codexhost",
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
        status: { type: "idle" },
        turns: [],
        preview: "",
        name: null,
        gitInfo: null,
        forkedFromId: null,
        parentThreadId: null,
        ephemeral: true,
        canAcceptDirectInput: true,
        historyMode: "paginated",
        agentNickname: null,
        agentRole: null,
        extra: null,
      };
      const piThread: PiThread = {
        id: threadId,
        cwd,
        session,
        outputTask: Promise.resolve(),
        thread,
        turns: [],
        running: false,
        activeTurnId: null,
        projectedTurns: new Map(),
        responseGates: new Map(),
      };
      piThread.outputTask = this.#consumeHarnessOutputs(piThread);
      this.#piThreads.set(threadId, piThread);
      await this.#writer.json(
        rpcEnvelope(request, {
          result: {
            thread,
            model: "codexhost/pi-native",
            modelProvider: "codexhost",
            cwd,
            approvalPolicy:
              typeof params.approvalPolicy === "string" ? params.approvalPolicy : "never",
            approvalsReviewer: "user",
            sandbox: sandboxResult(params),
            reasoningEffort: "medium",
            serviceTier: "default",
            multiAgentMode: "explicitRequestOnly",
            activePermissionProfile: null,
            runtimeWorkspaceRoots: Array.isArray(params.runtimeWorkspaceRoots)
              ? params.runtimeWorkspaceRoots
              : [],
            instructionSources: [],
          },
        }),
      );
      await this.#writer.json({
        method: "thread/started",
        emittedAtMs: Date.now(),
        params: { thread },
      });
    } catch (error) {
      this.#piThreads.delete(threadId);
      await session.close().catch(() => undefined);
      await this.#writer.json(
        rpcError(request, -32071, `Pi Session could not open: ${errorMessage(error)}`),
      );
    }
  }

  async #setPiThreadName(
    request: JsonRpcRequest,
    piThread: PiThread,
    name: JsonValue | undefined,
  ): Promise<void> {
    if (typeof name !== "string" || name.length === 0) {
      await this.#writer.json(
        rpcError(request, -32602, "Pi Thread name must be a non-empty string"),
      );
      return;
    }
    piThread.thread.name = name;
    piThread.thread.updatedAt = unixSeconds();
    await this.#writer.json(rpcEnvelope(request, { result: {} }));
    await this.#writer.json({
      method: "thread/name/updated",
      params: { threadId: piThread.id, threadName: name },
    });
  }

  async #deletePiThread(request: JsonRpcRequest, piThread: PiThread): Promise<void> {
    this.#piThreads.delete(piThread.id);
    this.#routeObservationTracker.forgetThread(piThread.id);
    try {
      await piThread.session.close();
      await piThread.outputTask;
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } catch (error) {
      await this.#writer.json(
        rpcError(request, -32075, `Pi Thread could not close: ${errorMessage(error)}`),
      );
    }
  }

  async #readPiThread(
    request: JsonRpcRequest,
    piThread: PiThread,
    includeTurns: boolean,
  ): Promise<void> {
    await this.#writer.json(
      rpcEnvelope(request, {
        result: {
          thread: {
            ...piThread.thread,
            turns: includeTurns ? piThread.turns : [],
          },
        },
      }),
    );
  }

  async #startPiTurn(request: JsonRpcRequest, thread: PiThread): Promise<void> {
    if (thread.running) {
      await this.#writer.json(rpcError(request, -32072, "Pi Thread already has an active Turn"));
      return;
    }
    let text: string;
    try {
      text = requestText(requestObject(request));
    } catch (error) {
      await this.#writer.json(rpcError(request, -32602, errorMessage(error)));
      return;
    }
    const turnId = hostTurnIdSchema.parse(randomUUID());
    const startedAtMs = Date.now();
    const projection: ProjectedTurn = {
      projector: new CodexTurnProjector({
        threadId: thread.id,
        turnId,
        cwd: thread.cwd,
        startedAtMs,
      }),
    };
    const gate = turnProjectionGate();
    thread.running = true;
    thread.activeTurnId = turnId;
    thread.projectedTurns.set(turnId, projection);
    thread.responseGates.set(turnId, gate);

    const result = await thread.session.execute({
      type: "turn.start",
      turnId,
      input: [{ type: "text", text }],
    });
    if (!result.ok) {
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(turnId);
      thread.responseGates.delete(turnId);
      gate.resolve();
      await this.#writer.json(rpcError(request, -32073, result.error.message));
      return;
    }
    try {
      await this.#writer.json(
        rpcEnvelope(request, { result: { turn: projection.projector.pendingTurn() } }),
      );
    } finally {
      gate.resolve();
    }
  }

  async #interruptPiTurn(
    request: JsonRpcRequest,
    thread: PiThread,
    requestedTurnId: JsonValue | undefined,
  ): Promise<void> {
    if (
      typeof requestedTurnId !== "string" ||
      !thread.running ||
      thread.activeTurnId !== requestedTurnId
    ) {
      await this.#writer.json(
        rpcError(request, -32074, "Pi turn/interrupt must reference the active Turn"),
      );
      return;
    }
    const turnId = thread.activeTurnId;
    const gate = turnProjectionGate();
    thread.responseGates.set(turnId, gate);
    const result = await thread.session.execute({ type: "turn.cancel", turnId });
    if (!result.ok) {
      gate.resolve();
      await this.#writer.json(rpcError(request, -32074, result.error.message));
      return;
    }
    try {
      await this.#writer.json(rpcEnvelope(request, { result: {} }));
    } finally {
      gate.resolve();
    }
  }

  async #consumeHarnessOutputs(thread: PiThread): Promise<void> {
    try {
      for await (const output of thread.session.outputs) {
        await this.#projectHarnessOutput(thread, output);
      }
    } catch (error) {
      this.#diagnose(error);
    }
  }

  async #projectHarnessOutput(thread: PiThread, output: HarnessOutput): Promise<void> {
    const event = output.event;
    if (event.type === "session.state.changed") return;
    if (event.type === "session.faulted") {
      this.#diagnose(`Pi Harness Session faulted: ${event.error.message}`);
      return;
    }

    const projection = this.#projectedTurn(thread, event.turnId);
    await this.#waitForTurnResponse(thread, event.turnId);
    const result = projection.projector.project(event as ProjectableHostEvent);
    if (event.type === "turn.started") {
      await this.#setThreadStatus(thread, { type: "active", activeFlags: [] });
    }
    if (event.type === "turn.completed") {
      if (!result.completedTurn) throw new Error("Turn projector returned no completed Turn");
      const completedAt = Math.floor(Date.now() / 1000);
      thread.turns.push(result.completedTurn);
      thread.thread.updatedAt = completedAt;
      thread.thread.recencyAt = completedAt;
      thread.running = false;
      thread.activeTurnId = null;
      thread.projectedTurns.delete(event.turnId);
      thread.responseGates.delete(event.turnId);
    }
    for (const message of result.messages) await this.#writer.json(message);
    if (event.type === "turn.completed") {
      await this.#setThreadStatus(thread, { type: "idle" });
    }
  }

  async #setThreadStatus(thread: PiThread, status: PiThreadStatus): Promise<void> {
    thread.thread.status = status;
    await this.#writer.json({
      method: "thread/status/changed",
      emittedAtMs: Date.now(),
      params: { threadId: thread.id, status },
    });
  }

  #projectedTurn(thread: PiThread, turnId: HostTurnId): ProjectedTurn {
    const projection = thread.projectedTurns.get(turnId);
    if (!projection) throw new Error("Harness output references an unknown Host Turn");
    return projection;
  }

  async #waitForTurnResponse(thread: PiThread, turnId: HostTurnId): Promise<void> {
    await thread.responseGates.get(turnId)?.promise;
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
