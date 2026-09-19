import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { zcodeInvocation } from "./command.js";
import { desktopWorker } from "./desktop-worker.js";
import { desktopDeadline, DesktopRelay, type DesktopPairing } from "./desktop-relay.js";
import { record, text } from "./protocol.js";
import { ZcodeError } from "./errors.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";
import type { DesktopSettings } from "./desktop-settings.js";

export interface DesktopService {
  readonly workspace: { workspacePath: string; workspaceIdentity?: string };
  readonly deviceSid: string;
  readonly desktopId: string;
  readonly clientId: string;
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  listen(
    method: string,
    params: Record<string, unknown>,
    listener: (event: unknown) => void,
  ): Promise<() => Promise<void>>;
  onFault(listener: (error: Error) => void): () => void;
  /** Unconfirmed creation/ownership makes this connection unsafe to retry. */
  invalidate(): void;
  close(): Promise<void>;
}
/** One Relay/bridge per Adapter, shared only by Sessions in the selected workspace. */
export class DesktopClient implements DesktopService {
  workspace: { workspacePath: string; workspaceIdentity?: string } = { workspacePath: "" };
  readonly clientId = `codexhost-${randomUUID()}`;
  #relay: DesktopRelay;
  #child: ChildProcessWithoutNullStreams | undefined;
  #ready = Promise.withResolvers<undefined>();
  #pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  #listeners = new Map<string, (value: unknown) => void>();
  #faultListeners = new Set<(error: Error) => void>();
  #id = 0;
  #closed = false;
  #closing: Promise<void> | undefined;
  #root: string | undefined;
  #release: (() => Promise<void>) | undefined;
  readonly deviceSid: string;
  readonly desktopId: string;
  constructor(
    readonly options: {
      cwd: string;
      environment: NodeJS.ProcessEnv;
      command?: string;
      timeoutMs?: number;
    },
    pairing: DesktopPairing,
  ) {
    this.deviceSid = pairing.deviceSid;
    this.desktopId = pairing.deviceMid ?? pairing.deviceSid;
    this.#relay = new DesktopRelay(pairing, options.timeoutMs ?? 15_000);
    void this.#ready.promise.catch(() => {});
  }
  async connect(settings: DesktopSettings) {
    try {
      if (process.platform !== "darwin")
        throw new ZcodeError(
          "unsupported",
          "ZCode Desktop pairing currently supports macOS 3.12.3; stdio remains available on other platforms",
        );
      const invocation = zcodeInvocation(this.options.environment, this.options.command);
      const script = invocation.arguments[0];
      if (
        !script ||
        path.basename(script) !== "zcode.cjs" ||
        path.basename(path.dirname(script)) !== "glm"
      )
        throw new ZcodeError(
          "unsupported",
          "Desktop pairing requires a ZCode application installation, not a standalone CLI",
        );
      const resources = path.dirname(path.dirname(script));
      const executable = path.resolve(resources, "..", "MacOS", "ZCode"),
        archive = path.join(resources, "app.asar");
      if (!(await stat(executable)).isFile() || !(await stat(archive)).isFile()) throw new Error();
      this.#release = await settings.acquire(this.deviceSid);
      this.#root = await realpath(await mkdtemp("/tmp/zcd-"));
      const quote = JSON.stringify;
      const policy = `(version 1)(allow default)(deny signal)(deny network*)(deny file-write*)(allow file-write* (subpath ${quote(this.#root)}) (literal "/dev/null"))(deny file-read* file-write* (subpath ${quote(await realpath(homedir()))}))(deny process-exec (literal "/usr/bin/open"))`;
      this.#child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          policy,
          executable,
          "--input-type=module",
          "-e",
          `(${desktopWorker.toString()})().catch(()=>process.exit(1))`,
        ],
        {
          cwd: this.#root,
          detached: true,
          stdio: "pipe",
          env: {
            PATH: "/usr/bin:/bin",
            HOME: this.#root,
            TMPDIR: this.#root,
            ELECTRON_RUN_AS_NODE: "1",
          },
        },
      );
      this.#child.stderr.resume();
      this.#child.on("error", () => this.#fault());
      this.#child.on("exit", () => this.#fault());
      this.#child.stdin.on("error", () => this.#fault());
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      this.#child.stdout.on("data", (data: Buffer) => {
        buffer += decoder.write(data);
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return this.#fault();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            this.#receive(record(JSON.parse(line)));
          } catch {
            this.#fault();
          }
        }
      });
      const identity = { bridgeSessionId: `codexhost-${randomUUID()}`, bridgeGeneration: 1 };
      this.#write({ type: "init", archive, identity });
      await desktopDeadline(this.#ready.promise, this.options.timeoutMs ?? 15_000);
      this.#relay.signal.addEventListener("abort", () => this.#fault(), { once: true });
      this.#relay.onPayload((payload) => {
        if (
          payload.zcode_type === "bridge-degraded" &&
          payload.bridgeSessionId === identity.bridgeSessionId
        )
          this.#fault();
        else if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack")
          this.#write({ type: "frame", payload });
      });
      await this.#relay.connect();
      const listing = await this.#relay.request(
        "workspace-list-request",
        "workspace-list-response",
      );
      const entries = record(listing.result).workspaces;
      const matches = Array.isArray(entries)
        ? entries
            .map(record)
            .filter(
              (entry) =>
                entry.kind === "local" &&
                sameWorkspaceDirectory(text(entry.workspacePath), this.options.cwd),
            )
        : [];
      const workspace = matches[0];
      if (
        listing.success !== true ||
        matches.length !== 1 ||
        !workspace ||
        (workspace.connectionState && workspace.connectionState !== "connected")
      )
        throw new ZcodeError(
          "unavailable",
          "Open this workspace in the paired ZCode Desktop window first",
        );
      this.workspace = {
        workspacePath: text(workspace.workspacePath),
        ...(text(workspace.workspaceIdentity)
          ? { workspaceIdentity: text(workspace.workspaceIdentity) }
          : {}),
      };
      const workspaceKey = this.workspace.workspaceIdentity?.trim() || this.workspace.workspacePath;
      const ready = await this.#relay.request("workspace-bridge-open", "workspace-bridge-ready", {
        ...identity,
        workspaceKey,
      });
      const bridge = record(ready.bridge);
      if (
        ready.bridgeSessionId !== identity.bridgeSessionId ||
        ready.bridgeGeneration !== 1 ||
        bridge.bridgeSessionId !== identity.bridgeSessionId ||
        bridge.bridgeGeneration !== 1 ||
        bridge.kind !== "local" ||
        bridge.workspacePath !== this.workspace.workspacePath ||
        bridge.workspaceKey !== workspaceKey ||
        bridge.recoveryId !== undefined
      )
        throw new ZcodeError("protocolError", "ZCode returned a different workspace bridge");
      const hello = record(await this.call("helloConversationV4", {}));
      if (hello.clientMode !== "web-remote-replayable" || hello.protocolVersion !== 3)
        throw new ZcodeError("unsupported", "Unsupported ZCode Desktop conversation protocol");
      await this.call("initializeConversationV4", {
        kind: "clientHello",
        protocolVersion: 3,
        clientId: this.clientId,
        clientKind: "web",
        appVersion: "3.12.3",
      });
    } catch (error) {
      await this.close();
      throw error instanceof ZcodeError
        ? error
        : new ZcodeError(
            "unavailable",
            "Could not initialize the installed ZCode Desktop protocol",
          );
    }
  }
  #write(message: unknown) {
    if (!this.#closed) this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
  }
  #receive(message: Record<string, unknown>) {
    if (message.type === "ready") this.#ready.resolve(undefined);
    else if (message.type === "frame") {
      if (!this.#relay.sendPayload(message.payload)) this.#fault();
    } else if (message.type === "event") this.#listeners.get(text(message.key))?.(message.value);
    else if (message.type === "result" && typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (typeof message.error === "number")
        pending.reject(
          new ZcodeError(
            message.error === -32004
              ? "sessionNotFound"
              : message.error === -32010
                ? "sessionBusy"
                : message.error === -32602
                  ? "invalidRequest"
                  : "nativeFailure",
            `ZCode Desktop request failed (${message.error})`,
            false,
            message.error,
          ),
        );
      else pending.resolve(message.result);
    } else this.#fault();
  }
  async #request(method: string, params: Record<string, unknown>, key?: string) {
    if (this.#closed)
      throw new ZcodeError(
        "unavailable",
        "ZCode Desktop connection is closed; restart codexhost to reconnect",
        true,
      );
    const id = ++this.#id,
      pending = Promise.withResolvers<unknown>();
    this.#pending.set(id, pending);
    this.#write({ type: "request", id, method, params, ...(key ? { key } : {}) });
    try {
      return await desktopDeadline(
        pending.promise,
        this.options.timeoutMs ?? 30_000,
        this.#relay.signal,
      );
    } catch (error) {
      if (this.#pending.has(id)) this.#fault();
      throw error;
    } finally {
      this.#pending.delete(id);
    }
  }
  call(method: string, params: Record<string, unknown>) {
    return this.#request(method, params);
  }
  async listen(
    method: string,
    params: Record<string, unknown>,
    listener: (value: unknown) => void,
  ) {
    const key = randomUUID();
    this.#listeners.set(key, listener);
    try {
      await this.#request(method, params, key);
    } catch (error) {
      this.#listeners.delete(key);
      throw error;
    }
    return async () => {
      this.#listeners.delete(key);
      if (!this.#closed) await this.#request("unsubscribe", {}, key);
    };
  }
  onFault(listener: (error: Error) => void) {
    this.#faultListeners.add(listener);
    return () => {
      this.#faultListeners.delete(listener);
    };
  }
  invalidate() {
    this.#fault();
  }
  #fault() {
    if (this.#closed) return;
    const error = new ZcodeError(
      "unavailable",
      "ZCode Desktop connection lost; native execution or cleanup may be unconfirmed",
      true,
    );
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const listener of this.#faultListeners) listener(error);
    void this.close().catch(() => {});
  }
  close() {
    return (this.#closing ??= this.#close());
  }
  async #close() {
    this.#closed = true;
    this.#relay.close();
    for (const pending of this.#pending.values())
      pending.reject(new ZcodeError("invalidState", "ZCode Desktop connection closed"));
    this.#pending.clear();
    this.#listeners.clear();
    this.#faultListeners.clear();
    const child = this.#child;
    if (child) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Only our helper, never Desktop. */
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
    if (this.#root) await rm(this.#root, { recursive: true, force: true });
    await this.#release?.();
  }
}
