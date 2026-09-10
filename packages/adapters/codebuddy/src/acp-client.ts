import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { codeBuddyInvocation } from "./command.js";
import { bounded, CodeBuddyError, record } from "./common.js";

export interface CodeBuddyClientHandlers {
  update(notification: SessionNotification): void;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  question(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  fault(error: unknown): void;
}

export interface CodeBuddyClient {
  initialize(): Promise<Record<string, unknown>>;
  open(cwd: string, sessionId?: string): Promise<Record<string, unknown>>;
  configure(sessionId: string, configId: string, value: string): Promise<Record<string, unknown>>;
  prompt(sessionId: string, input: string): Promise<Record<string, unknown>>;
  cancel(sessionId: string): Promise<void>;
  answer(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string[]> | null,
  ): Promise<void>;
  close(): Promise<void>;
}

export type CodeBuddyClientFactory = (options: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  ephemeral: boolean;
  handlers: CodeBuddyClientHandlers;
}) => CodeBuddyClient;

/** One native process per Session; all tool execution stays in CodeBuddy. */
export class CodeBuddyAcpClient implements CodeBuddyClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: ClientSideConnection;
  readonly #exited: Promise<void>;
  #closing: Promise<void> | undefined;
  #failure: unknown;
  #exitFailure: CodeBuddyError | undefined;
  #exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
  #rejectFailure!: (error: unknown) => void;
  readonly #failed = new Promise<never>((_, reject) => {
    this.#rejectFailure = reject;
  });

  constructor(
    readonly options: Parameters<CodeBuddyClientFactory>[0],
    readonly operationTimeoutMs = 15_000,
  ) {
    void this.#failed.catch(() => {});
    const invocation = codeBuddyInvocation(options.environment, options.ephemeral);
    this.#child = spawn(invocation.command, invocation.arguments, {
      cwd: options.cwd,
      env: invocation.environment,
      stdio: "pipe",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
    });
    this.#exited = new Promise((resolve) => this.#child.once("close", () => resolve()));
    this.#child.stderr.on("data", () => {
      /* Native diagnostics can contain credentials. */
    });
    this.#child.on("error", (error) => {
      this.#fault(error);
    });
    this.#child.once("exit", (code, signal) => {
      if (this.#closing || this.#failure) return;
      const error = new CodeBuddyError(
        "processExited",
        `ACP process exited (${code ?? signal ?? "unknown"})`,
      );
      this.#exitFailure = error;
      // Pipe data can arrive after exit. Briefly drain already-written updates,
      // but do not wait indefinitely for EOF held open by a descendant.
      this.#exitDrainTimer = setTimeout(() => this.#fault(error), 250);
    });
    this.#child.stdin.on("error", () => {
      /* The connection/close path owns failures. */
    });
    this.#connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (notification) => {
          if (!this.#closing && !this.#failure) options.handlers.update(notification);
        },
        requestPermission: (request) =>
          !this.#exitFailure && !this.#closing && !this.#failure
            ? options.handlers.permission(request)
            : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        extMethod: async (method, params) => {
          if (method !== "_codebuddy.ai/question") throw RequestError.methodNotFound(method);
          if (this.#exitFailure || this.#closing || this.#failure) return { outcome: "cancelled" };
          return options.handlers.question(params);
        },
      }),
      ndJsonStream(
        Writable.toWeb(this.#child.stdin) as Parameters<typeof ndJsonStream>[0],
        Readable.toWeb(this.#child.stdout) as Parameters<typeof ndJsonStream>[1],
      ),
    );
    void this.#connection.closed
      .then(() => {
        this.#fault(new CodeBuddyError("processExited", "ACP connection closed"));
      })
      .catch((error) => {
        this.#fault(error);
      });
  }

  #fault(error: unknown) {
    if (this.#closing || this.#failure) return;
    clearTimeout(this.#exitDrainTimer);
    this.#failure = error;
    this.#rejectFailure(error);
    this.options.handlers.fault(error);
    void this.close().catch(() => {});
  }

  async #request<T>(
    operation: () => Promise<T>,
    label?: string,
    timeout = this.operationTimeoutMs,
  ): Promise<T> {
    if (this.#failure) throw this.#failure;
    if (this.#exitFailure) throw this.#exitFailure;
    if (this.#closing) throw new CodeBuddyError("invalidState", "ACP client is closed");
    const work = Promise.race([operation(), this.#failed]);
    return label ? bounded(work, timeout, label, (error) => this.#fault(error)) : work;
  }

  async initialize() {
    const result = await this.#request(
      () =>
        this.#connection.initialize({
          protocolVersion: 1,
          clientInfo: { name: "codexhost", version: "0.0.0" },
          clientCapabilities: { _meta: { "codebuddy.ai": { question: true } } },
        }),
      "ACP initialize",
      15_000,
    );
    if (result.protocolVersion !== 1 || !result.agentCapabilities?.loadSession) {
      throw new CodeBuddyError("unsupported", "ACP v1 with session/load is required");
    }
    return record(result);
  }

  async open(cwd: string, sessionId?: string) {
    return record(
      await this.#request(
        () =>
          sessionId
            ? this.#connection.loadSession({ cwd, sessionId, mcpServers: [] })
            : this.#connection.newSession({ cwd, mcpServers: [] }),
        "ACP Session open",
        20_000,
      ),
    );
  }

  async configure(sessionId: string, configId: string, value: string) {
    return record(
      await this.#request(
        () => this.#connection.setSessionConfigOption({ sessionId, configId, value }),
        "ACP configuration",
      ),
    );
  }

  async prompt(sessionId: string, input: string) {
    return record(
      await this.#request(() =>
        this.#connection.prompt({ sessionId, prompt: [{ type: "text", text: input }] }),
      ),
    );
  }

  async cancel(sessionId: string) {
    await this.#request(() => this.#connection.cancel({ sessionId }), "ACP cancel");
  }

  async answer(sessionId: string, toolCallId: string, answers: Record<string, string[]> | null) {
    const response = await this.#request(
      () =>
        this.#connection.extMethod("_codebuddy.ai/resolveInterruption", {
          sessionId,
          toolCallId,
          decision: answers === null ? "deny" : "allow",
          ...(answers ? { answers } : {}),
        }),
      "CodeBuddy question response",
    );
    if (record(response).resolved !== true)
      throw new CodeBuddyError("protocolError", "Native question is no longer pending");
  }

  close(): Promise<void> {
    clearTimeout(this.#exitDrainTimer);
    this.#rejectFailure(new CodeBuddyError("invalidState", "ACP client is closed"));
    this.#closing ??= this.#closeProcess();
    return this.#closing;
  }

  async #closeProcess() {
    this.#child.stdin.end();
    const exited = await bounded(
      this.#exited.then(() => true),
      1_000,
      "ACP shutdown",
    ).catch(() => false);
    if (exited) return;
    // A dead parent's PID can be reused while descendants keep its pipes open.
    // Never target such a PID with taskkill or a process-group signal.
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
      await bounded(this.#exited, 3_000, "ACP closed process pipes");
      return;
    }
    const pid = this.#child.pid;
    if (pid && process.platform === "win32") {
      await new Promise<void>((resolve) =>
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 3_000 },
          () => resolve(),
        ),
      );
    } else if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    await bounded(this.#exited, 3_000, "ACP process exit");
  }
}
