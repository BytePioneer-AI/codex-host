import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { PiRpcSession } from "@codexhost/adapter-pi";
import { LazyPiSession, type PiTextSession } from "./lazy-pi-session.js";
import {
  classifyThreadPurpose,
  RequestRouteObservationTracker,
  type CreateRequestRouteObservation,
  type RequestRouteObservation,
} from "./route-observation.js";
import {
  decodeCreateRoute,
  parseJsonFrame,
  readLfFrames,
  writeFrame,
  writeJsonFrame,
  jsonRpcRequestSchema,
  type JsonObject,
  type JsonRpcRequest,
  type JsonValue,
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
  spawnOfficial?: typeof spawn;
  onCreateRequestRoute?: (observation: CreateRequestRouteObservation) => void;
  onRequestRoute?: (observation: RequestRouteObservation) => void;
}

interface PiThread {
  id: string;
  cwd: string;
  session: LazyPiSession;
  thread: JsonObject;
  turns: JsonObject[];
  running: boolean;
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

function pendingTurn(id: string, startedAt: number | null): JsonObject {
  return {
    id,
    status: "inProgress",
    items: [],
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
    itemsView: "full",
  };
}

function completedTurn(
  id: string,
  startedAt: number,
  completedAt: number,
  item: JsonObject,
): JsonObject {
  return {
    id,
    status: "completed",
    items: [item],
    error: null,
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt) * 1000,
    itemsView: "full",
  };
}

function failedTurn(
  id: string,
  startedAt: number,
  completedAt: number,
  message: string,
): JsonObject {
  return {
    id,
    status: "failed",
    items: [],
    error: { message },
    startedAt,
    completedAt,
    durationMs: Math.max(0, completedAt - startedAt) * 1000,
    itemsView: "full",
  };
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
      await Promise.allSettled([...this.#piThreads.values()].map(({ session }) => session.close()));
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
      if (request.method === "thread/read") {
        const params = requestObject(request);
        const threadId = params.threadId;
        const piThread = typeof threadId === "string" ? this.#piThreads.get(threadId) : undefined;
        if (piThread) {
          await this.#readPiThread(request, piThread, params.includeTurns === true);
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
    const threadId = randomUUID();
    this.#routeObservationTracker.bindCreatedThread(request.id, threadId);
    const session = new LazyPiSession(
      (): PiTextSession =>
        new PiRpcSession({
          cwd,
          ...(this.#options.piCommand ? { command: this.#options.piCommand } : {}),
          environment: this.#options.environment ?? process.env,
        }),
    );
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
      this.#piThreads.set(threadId, {
        id: threadId,
        cwd,
        session,
        thread,
        turns: [],
        running: false,
      });
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
      await session.close().catch(() => undefined);
      await this.#writer.json(
        rpcError(request, -32071, `Pi Session could not start: ${errorMessage(error)}`),
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
    const turnId = randomUUID();
    const itemId = randomUUID();
    const startedAtMs = Date.now();
    const startedAt = Math.floor(startedAtMs / 1000);
    const item: JsonObject = {
      id: itemId,
      type: "agentMessage",
      text: "",
      phase: null,
      memoryCitation: null,
    };
    thread.running = true;
    await this.#writer.json(rpcEnvelope(request, { result: { turn: pendingTurn(turnId, null) } }));
    await this.#writer.json({
      method: "turn/started",
      emittedAtMs: startedAtMs,
      params: { threadId: thread.id, turn: pendingTurn(turnId, startedAt) },
    });
    await this.#writer.json({
      method: "item/started",
      emittedAtMs: startedAtMs,
      params: { threadId: thread.id, turnId, startedAtMs, item },
    });

    void thread.session
      .runTextTurn(text, (delta) => {
        void this.#writer.json({
          method: "item/agentMessage/delta",
          emittedAtMs: Date.now(),
          params: { threadId: thread.id, turnId, itemId, delta },
        });
      })
      .then(async ({ text: output }) => {
        const completedAtMs = Date.now();
        const completedAt = Math.floor(completedAtMs / 1000);
        const completedItem: JsonObject = { ...item, text: output };
        const completed = completedTurn(turnId, startedAt, completedAt, completedItem);
        thread.turns.push(completed);
        thread.thread.updatedAt = completedAt;
        thread.thread.recencyAt = completedAt;
        await this.#writer.json({
          method: "item/completed",
          emittedAtMs: completedAtMs,
          params: { threadId: thread.id, turnId, completedAtMs, item: completedItem },
        });
        await this.#writer.json({
          method: "turn/completed",
          emittedAtMs: completedAtMs,
          params: { threadId: thread.id, turn: completed },
        });
      })
      .catch(async (error) => {
        const completedAtMs = Date.now();
        const completedAt = Math.floor(completedAtMs / 1000);
        const failed = failedTurn(turnId, startedAt, completedAt, errorMessage(error));
        thread.turns.push(failed);
        thread.thread.updatedAt = completedAt;
        thread.thread.recencyAt = completedAt;
        await this.#writer.json({
          method: "turn/completed",
          emittedAtMs: completedAtMs,
          params: { threadId: thread.id, turn: failed },
        });
      })
      .finally(() => {
        thread.running = false;
      });
  }

  #diagnose(error: unknown): void {
    this.#options.diagnosticOutput.write(`codexhost Host Runtime: ${errorMessage(error)}\n`);
  }
}
