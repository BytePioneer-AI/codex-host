import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { TRAE_CLI_ID, traeError, rejected, TraeCliError } from "./common.js";
import { cliCatalog, capabilities } from "./configuration.js";
import { traeInvocation } from "./command.js";
import { TraeTransport, type TraeOptions } from "./transport.js";
import { TraeSession } from "./session.js";

export class TraeCliAdapter implements HarnessAdapter {
  readonly harnessId = TRAE_CLI_ID;
  #closed = false;
  #closing: Promise<void> | undefined;
  #sessions = new Set<TraeSession>();
  #probes = new Set<TraeTransport>();
  #commands = new Set<AbortController>();
  #cache = new Map<string, Promise<HarnessInspection>>();
  constructor(readonly options: TraeOptions = {}) {}
  inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return Promise.resolve({
        status: "unavailable",
        error: { code: "invalidState", message: "TRAE CLI Adapter is closed", retryable: false },
      });
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const key = JSON.stringify([cwd, input.purpose]);
    const cached = this.#cache.get(key);
    if (!input.refresh && cached) return cached;
    const result = this.#inspect(cwd, input.purpose);
    this.#cache.set(key, result);
    void result.then((value) => {
      if (value.status !== "ready" && this.#cache.get(key) === result) this.#cache.delete(key);
    });
    return result;
  }
  async #inspect(cwd: string, purpose?: string): Promise<HarnessInspection> {
    const transport = new TraeTransport(cwd, this.options);
    this.#probes.add(transport);
    const abort = new AbortController();
    this.#commands.add(abort);
    try {
      await transport.connect();
      await transport.listSessions();
      let catalog = { models: [], thinkingOptions: [] } as ReturnType<typeof cliCatalog>;
      if (purpose !== "availability") {
        const environment = this.options.environment ?? process.env;
        const command = traeInvocation(environment, this.options.command, ["models", "--json"]);
        const { stdout } = await promisify(execFile)(command.command, command.arguments, {
          cwd,
          env: environment,
          windowsHide: true,
          windowsVerbatimArguments: command.windowsVerbatimArguments,
          timeout: this.options.timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024,
          signal: abort.signal,
        });
        catalog = cliCatalog(JSON.parse(stdout));
        if (!catalog.models.length)
          throw new TraeCliError(
            "configurationRequired",
            "TRAE CLI has no available CLI models; check account access and native configuration",
          );
      }
      if (this.#closed)
        throw new TraeCliError("invalidState", "TRAE CLI Adapter closed during inspection");
      return {
        status: "ready",
        catalog,
        capabilities: {
          ...capabilities({}),
          configuration: {
            ...capabilities({}).configuration,
            selectModel: catalog.models.length > 0,
          },
        },
      };
    } catch (error) {
      const failure = traeError(error);
      return {
        status: failure.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: failure,
      };
    } finally {
      await transport.close();
      this.#probes.delete(transport);
      this.#commands.delete(abort);
    }
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return rejected("invalidState", "TRAE CLI Adapter is closed");
    if (!path.isAbsolute(input.cwd))
      return rejected("invalidRequest", "TRAE CLI workspace must be absolute");
    if (input.kind === "fork" || input.kind === "rollbackLastTurn")
      return rejected(
        "unsupported",
        "TRAE CLI checkpoint-precise derivation has not been verified",
      );
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access")
      return rejected(
        "unsupported",
        "TRAE CLI unattended permission equivalence has not been verified",
      );
    if (
      input.kind === "resume" &&
      (input.nativeRef.harnessId !== TRAE_CLI_ID ||
        typeof input.nativeRef.locator !== "object" ||
        input.nativeRef.locator === null ||
        Array.isArray(input.nativeRef.locator) ||
        input.nativeRef.locator.cwd !== path.resolve(input.cwd))
    )
      return rejected("invalidRequest", "TRAE CLI Session identity or workspace does not match");
    const transport = new TraeTransport(path.resolve(input.cwd), {
      ...this.options,
      environment: { ...(this.options.environment ?? process.env), ...input.environment },
    });
    this.#probes.add(transport);
    let session: TraeSession | undefined;
    try {
      await transport.connect();
      await transport.listSessions();
      if (this.#closed)
        throw new TraeCliError("invalidState", "TRAE CLI Adapter closed during open");
      const opened = new TraeSession(transport, input.kind === "create" ? input : undefined, () =>
        this.#sessions.delete(opened),
      );
      session = opened;
      if (input.kind === "resume") {
        transport.sessionId = input.nativeRef.nativeSessionId;
        const snapshot = await opened.restore();
        if (
          input.knownTurnRefs?.some(
            (ref) =>
              ref.harnessId !== TRAE_CLI_ID ||
              ref.nativeSessionId !== transport.sessionId ||
              !snapshot.turns.some(
                (turn) => turn.nativeTurnRef.nativeTurnKey === ref.nativeTurnKey,
              ),
          )
        )
          throw new TraeCliError(
            "protocolError",
            "TRAE CLI history no longer contains a known Turn; input was not resent",
          );
      }
      if (this.#closed)
        throw new TraeCliError("invalidState", "TRAE CLI Adapter closed during open");
      this.#sessions.add(opened);
      return { ok: true, value: opened };
    } catch (error) {
      await (session ? session.close() : transport.close());
      return { ok: false, error: traeError(error) };
    } finally {
      this.#probes.delete(transport);
    }
  }
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const command of this.#commands) command.abort();
    return (this.#closing = (async () => {
      await Promise.allSettled(
        [...this.#sessions]
          .map((session) => session.close())
          .concat([...this.#probes].map((probe) => probe.close())),
      );
      await Promise.allSettled(this.#cache.values());
      this.#cache.clear();
    })());
  }
}
