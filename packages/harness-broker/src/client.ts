import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import net, { type Socket } from "node:net";

import {
  HarnessOutputChannel,
  parseHostUsage,
  type HarnessAdapter,
  type HarnessCommandAccepted,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessInspection,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostCommand,
  type HostThreadSnapshot,
  type HostUsage,
  type InspectHarnessInput,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCommand,
  type ModelSelectCompleted,
  type OpenSessionInput,
  type PermissionModeSelectCommand,
  type PermissionModeSelectCompleted,
  type ThinkingSelectCommand,
  type ThinkingSelectCompleted,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnSteerAccepted,
  type TurnSteerCommand,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessInspectionSchema,
  harnessSessionCapabilitiesSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

import { consumeBrokerFrames, writeBrokerFrame } from "./framing.js";
import { defaultHarnessBrokerDescriptorPath } from "./paths.js";
import {
  HARNESS_BROKER_MAX_PENDING_REQUESTS,
  HARNESS_BROKER_PROTOCOL_VERSION,
  HARNESS_BROKER_REQUEST_TIMEOUT_MS,
  harnessBrokerDescriptorSchema,
  harnessBrokerServerFrameSchema,
  type HarnessBrokerDescriptorV1,
  type HarnessBrokerMethod,
} from "./protocol.js";
import {
  harnessErrorSchema,
  harnessOutputSchema,
  harnessSessionStateSchema,
} from "./validation.js";

interface SessionMetadata {
  sessionId: string;
  sessionGeneration: number;
  capabilities: HarnessSessionCapabilities;
  initialState: HarnessSessionState;
  initialUsage: HostUsage | null;
  commands: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

function unavailable(message: string, retryable = true): HarnessError {
  return { code: "unavailable", message, retryable, stage: "harnessBroker" };
}

function failedInspection(message: string): HarnessInspection {
  return { status: "unavailable", error: unavailable(message) };
}

function isAuthenticationTerminal(output: HarnessOutput): boolean {
  return (
    output.kind === "event" &&
    output.event.type === "turn.completed" &&
    output.event.outcome.status === "failed" &&
    output.event.outcome.error.code === "authenticationRequired"
  );
}

function parseHarnessResult<T>(value: unknown): HarnessResult<T> {
  if (!value || typeof value !== "object" || !("ok" in value)) {
    return {
      ok: false,
      error: {
        ...unavailable("Harness broker returned an invalid result", false),
        code: "protocolError",
      },
    };
  }
  const result = value as { ok: boolean; value?: T; error?: unknown };
  if (result.ok) return { ok: true, value: result.value as T };
  const error = harnessErrorSchema.safeParse(result.error);
  if (!error.success) {
    return {
      ok: false,
      error: {
        ...unavailable("Harness broker returned an invalid error", false),
        code: "protocolError",
      },
    };
  }
  const parsed = error.data;
  return {
    ok: false,
    error: {
      code: parsed.code,
      message: parsed.message,
      retryable: parsed.retryable,
      ...(parsed.diagnostic ? { diagnostic: parsed.diagnostic } : {}),
      ...(parsed.stage ? { stage: parsed.stage } : {}),
      ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
      ...(parsed.stderrTail ? { stderrTail: parsed.stderrTail } : {}),
    },
  };
}

function parseSessionMetadata(value: unknown): SessionMetadata {
  if (!value || typeof value !== "object")
    throw new Error("Harness broker Session metadata is invalid");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sessionId !== "string" || typeof candidate.sessionGeneration !== "number") {
    throw new Error("Harness broker Session identity is invalid");
  }
  const state = harnessSessionStateSchema.parse(candidate.initialState);
  return {
    sessionId: candidate.sessionId,
    sessionGeneration: candidate.sessionGeneration,
    capabilities: harnessSessionCapabilitiesSchema.parse(candidate.capabilities),
    initialState: state,
    initialUsage: candidate.initialUsage === null ? null : parseHostUsage(candidate.initialUsage),
    commands: candidate.commands === true,
  };
}

async function readDescriptor(descriptorPath: string): Promise<HarnessBrokerDescriptorV1> {
  const metadata = await lstat(descriptorPath);
  if (metadata.isSymbolicLink())
    throw new Error("Claude Aqua broker descriptor must not be a symlink");
  if (!metadata.isFile()) throw new Error("Claude Aqua broker descriptor is not a file");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0)
      throw new Error("Claude Aqua broker descriptor is not owner-only");
    if (process.getuid && metadata.uid !== process.getuid()) {
      throw new Error("Claude Aqua broker descriptor belongs to another user");
    }
  }
  const descriptor = harnessBrokerDescriptorSchema.parse(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  if (process.platform === "darwin" && Buffer.byteLength(descriptor.socketPath) > 103) {
    throw new Error("Claude Aqua broker socket path is too long for macOS");
  }
  if (process.platform !== "win32") {
    const socket = await lstat(descriptor.socketPath);
    if (socket.isSymbolicLink() || !socket.isSocket()) {
      throw new Error("Claude Aqua broker endpoint is not a Unix socket");
    }
    if ((socket.mode & 0o077) !== 0 || (process.getuid && socket.uid !== process.getuid())) {
      throw new Error("Claude Aqua broker endpoint is not owner-only");
    }
  }
  try {
    process.kill(descriptor.ownerPid, 0);
  } catch {
    throw new Error("Claude Aqua broker owner process is unavailable");
  }
  return descriptor;
}

class BrokerConnection {
  readonly #descriptor: HarnessBrokerDescriptorV1;
  readonly #socket: Socket;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessions = new Map<string, BrokeredHarnessSession>();
  #inputSequence = 1;
  #outputSequence = 0;
  #closed = false;
  #failed = false;

  private constructor(descriptor: HarnessBrokerDescriptorV1, socket: Socket) {
    this.#descriptor = descriptor;
    this.#socket = socket;
    consumeBrokerFrames(
      socket,
      (raw) => this.#frame(raw),
      (error) => this.#fail(error),
    );
    socket.once("close", () => this.#fail(new Error("Claude Aqua broker connection closed")));
    socket.once("error", (error) => this.#fail(error));
  }

  static async connect(descriptorPath: string): Promise<BrokerConnection> {
    const descriptor = await readDescriptor(descriptorPath);
    const socket = net.createConnection(descriptor.socketPath);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to Claude Aqua broker")),
        HARNESS_BROKER_REQUEST_TIMEOUT_MS,
      );
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const connection = new BrokerConnection(descriptor, socket);
    const hello = connection.#waitForHello();
    await writeBrokerFrame(socket, {
      version: HARNESS_BROKER_PROTOCOL_VERSION,
      generation: descriptor.generation,
      sequence: 1,
      kind: "hello",
      token: descriptor.token,
    });
    await hello;
    return connection;
  }

  #waitForHello(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = "__hello__";
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Claude Aqua broker authentication timed out"));
      }, HARNESS_BROKER_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: () => resolve(), reject, timeout });
    });
  }

  register(session: BrokeredHarnessSession): void {
    this.#sessions.set(session.sessionId, session);
  }

  unregister(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  async request(method: HarnessBrokerMethod, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("Claude Aqua broker connection is closed");
    if (this.#pending.size >= HARNESS_BROKER_MAX_PENDING_REQUESTS) {
      throw new Error("Claude Aqua broker request limit exceeded");
    }
    this.#inputSequence += 1;
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Claude Aqua broker ${method} timed out`));
      }, HARNESS_BROKER_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    await writeBrokerFrame(this.#socket, {
      version: HARNESS_BROKER_PROTOCOL_VERSION,
      generation: this.#descriptor.generation,
      sequence: this.#inputSequence,
      kind: "request",
      id,
      method,
      params,
    });
    return response;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#fail(new Error("Claude Aqua broker connection closed"));
  }

  #frame(raw: unknown): void {
    const frame = harnessBrokerServerFrameSchema.parse(raw);
    if (
      frame.generation !== this.#descriptor.generation ||
      frame.sequence !== this.#outputSequence + 1
    ) {
      this.#fail(new Error("Claude Aqua broker response generation or sequence is invalid"));
      return;
    }
    this.#outputSequence = frame.sequence;
    if (frame.kind === "output") {
      this.#sessions.get(frame.sessionId)?.acceptOutput(frame.sessionGeneration, frame.output);
      return;
    }
    if (this.#outputSequence === 1) {
      const hello = this.#pending.get("__hello__");
      if (hello) {
        clearTimeout(hello.timeout);
        this.#pending.delete("__hello__");
        if (frame.ok) hello.resolve(frame.value);
        else hello.reject(new Error(frame.error?.message ?? "Broker authentication failed"));
      }
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      this.#fail(new Error("Claude Aqua broker returned an unknown response ID"));
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(frame.id);
    if (frame.ok) pending.resolve(frame.value);
    else pending.reject(new Error(frame.error?.message ?? "Broker request failed"));
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    if (!this.#closed) this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const session of this.#sessions.values()) session.connectionFault(error);
  }
}

class BrokeredHarnessSession implements HarnessSession {
  readonly harnessId = harnessIdSchema.parse("claude-code");
  readonly outputs: AsyncIterable<HarnessOutput>;
  readonly #channel = new HarnessOutputChannel<HarnessOutput>();
  readonly #connection: BrokerConnection;
  readonly commands?: HarnessCommandCapability;
  #metadata: SessionMetadata;
  #faulted = false;
  #closed = false;

  constructor(connection: BrokerConnection, metadata: SessionMetadata) {
    this.#connection = connection;
    this.#metadata = metadata;
    this.outputs = this.#channel.outputs;
    if (metadata.commands) {
      this.commands = {
        list: async () => {
          try {
            return parseHarnessResult(await this.#request("session.commands.list", {}));
          } catch (error) {
            return {
              ok: false,
              error: unavailable(error instanceof Error ? error.message : String(error)),
            };
          }
        },
        execute: async (
          command: HarnessCommandInvocation,
        ): Promise<HarnessResult<HarnessCommandAccepted>> => {
          try {
            return parseHarnessResult(await this.#request("session.commands.execute", { command }));
          } catch (error) {
            return {
              ok: false,
              error: unavailable(error instanceof Error ? error.message : String(error)),
            };
          }
        },
      };
    }
    connection.register(this);
  }

  get sessionId(): string {
    return this.#metadata.sessionId;
  }
  get capabilities(): HarnessSessionCapabilities {
    return this.#metadata.capabilities;
  }
  get initialState(): HarnessSessionState {
    return this.#metadata.initialState;
  }
  get initialUsage(): HostUsage | null {
    return this.#metadata.initialUsage;
  }
  acceptOutput(generation: number, output: unknown): void {
    if (this.#closed || generation !== this.#metadata.sessionGeneration) return;
    const value = harnessOutputSchema.parse(output);
    if (
      (value.kind === "event" && value.event.type === "session.faulted") ||
      isAuthenticationTerminal(value)
    ) {
      this.#faulted = true;
    }
    this.#channel.emit(value);
  }

  connectionFault(error: Error): void {
    if (this.#closed) return;
    this.#faulted = true;
    this.#channel.emit({
      kind: "event",
      event: { type: "session.faulted", error: unavailable(error.message) },
    });
  }

  async refreshUsage(): Promise<void> {
    await this.#request("session.refreshUsage", {});
  }
  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    try {
      return parseHarnessResult(await this.#request("session.readSnapshot", {}));
    } catch (error) {
      return {
        ok: false,
        error: unavailable(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnSteerCommand): Promise<HarnessResult<TurnSteerAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnSteerAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed)
      return { ok: false, error: unavailable("Claude Aqua broker Session is closed", false) };
    if (this.#faulted && command.type === "turn.start") {
      try {
        const reopened = parseHarnessResult<SessionMetadata>(
          await this.#request("session.reopen", {}),
        );
        if (!reopened.ok) return reopened;
        this.#metadata = parseSessionMetadata(reopened.value);
        this.#faulted = false;
      } catch (error) {
        return {
          ok: false,
          error: unavailable(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    try {
      return parseHarnessResult(await this.#request("session.execute", { command }));
    } catch (error) {
      return {
        ok: false,
        error: unavailable(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.unregister(this.sessionId);
    await this.#request("session.close", {}).catch(() => undefined);
    this.#channel.end();
  }

  #request(method: HarnessBrokerMethod, extra: Record<string, unknown>): Promise<unknown> {
    return this.#connection.request(method, {
      sessionId: this.#metadata.sessionId,
      sessionGeneration: this.#metadata.sessionGeneration,
      ...extra,
    });
  }
}

export class BrokeredHarnessAdapter implements HarnessAdapter {
  readonly commandCatalog?: HarnessCommandCatalog;
  readonly harnessId = harnessIdSchema.parse("claude-code");
  readonly #descriptorPath: string;
  #connection: Promise<BrokerConnection> | null = null;
  #closed = false;

  readonly subagents = {
    readSnapshot: async (
      input: Parameters<NonNullable<HarnessAdapter["subagents"]>["readSnapshot"]>[0],
    ) => {
      try {
        return parseHarnessResult<HostThreadSnapshot>(
          await (await this.#connect()).request("adapter.subagent.readSnapshot", input),
        );
      } catch (error) {
        return {
          ok: false as const,
          error: unavailable(error instanceof Error ? error.message : String(error)),
        };
      }
    },
  };

  constructor(
    input: {
      descriptorPath?: string;
      environment?: NodeJS.ProcessEnv;
      commandCatalog?: HarnessCommandCatalog;
    } = {},
  ) {
    if (input.commandCatalog) this.commandCatalog = input.commandCatalog;
    this.#descriptorPath =
      input.descriptorPath ?? defaultHarnessBrokerDescriptorPath(input.environment);
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed) return failedInspection("Claude Aqua broker adapter is closed");
    try {
      return harnessInspectionSchema.parse(
        await (await this.#connect()).request("adapter.inspect", input),
      );
    } catch (error) {
      this.#connection = null;
      return failedInspection(error instanceof Error ? error.message : String(error));
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed)
      return { ok: false, error: unavailable("Claude Aqua broker adapter is closed", false) };
    try {
      const safeInput = { ...input } as OpenSessionInput & {
        environment?: Record<string, string | undefined>;
      };
      delete safeInput.environment;
      const result = parseHarnessResult<unknown>(
        await (await this.#connect()).request("adapter.open", safeInput),
      );
      if (!result.ok) return result;
      return {
        ok: true,
        value: new BrokeredHarnessSession(
          await this.#connect(),
          parseSessionMetadata(result.value),
        ),
      };
    } catch (error) {
      this.#connection = null;
      return {
        ok: false,
        error: unavailable(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const connection = await this.#connection?.catch(() => null);
    connection?.close();
    this.#connection = null;
  }

  #connect(): Promise<BrokerConnection> {
    if (!this.#connection) this.#connection = BrokerConnection.connect(this.#descriptorPath);
    return this.#connection;
  }
}
