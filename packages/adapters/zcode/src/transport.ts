import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { withNodeRuntimeOnPath } from "@codexhost/harness-discovery";
import type { HarnessLocalPage } from "@codexhost/harness-adapter/plugin";
import { ZcodeError } from "./errors.js";
import { record, text } from "./protocol.js";

export const ZCODE_SOURCE_REVISION = "29628c9acdb81b703bbd4080c207a0e7ce5e276e";
export interface TransportOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
  runtimeDirectory?: string;
  timeoutMs?: number;
  openLocalPage?: (url: string) => Promise<HarnessLocalPage>;
}
export interface RpcMessage {
  id?: string | number;
  method: string;
  params: unknown;
}
export class ServiceTransport {
  readonly clientId = `codexhost-${randomUUID()}`;
  readonly locator = { backend: "local-service", sourceRevision: ZCODE_SOURCE_REVISION };
  onFault: ((error: Error) => void) | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 0;
  #listeners = new Map<string, (value: unknown) => void>();
  #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #fault: Error | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #pages = new Map<string, Promise<HarnessLocalPage>>();
  constructor(readonly options: TransportOptions) {}

  async start() {
    if (this.#child || this.#closed)
      throw new ZcodeError("invalidState", "ZCode transport already started or closed");
    if (Number(process.versions.node.split(".")[0]) < 24)
      throw new ZcodeError("unsupported", "ZCode local services require Node 24 or newer");
    const env = withNodeRuntimeOnPath(this.options.environment);
    const root =
      this.options.runtimeDirectory ??
      this.options.command ??
      env.CODEXHOST_ZCODE_RUNTIME_DIR ??
      path.join(
        env.CODEXHOST_DATA_DIR ?? path.join(env.HOME ?? homedir(), ".codexhost"),
        "runtimes",
        "zcode",
        "3.14.3",
      );
    let manifest: Record<string, unknown>;
    try {
      manifest = record(JSON.parse(await readFile(path.join(root, "runtime.json"), "utf8")));
    } catch {
      throw new ZcodeError(
        "notInstalled",
        "Build/install the ZCode 3.14.3 local runtime; see the ZCode Adapter setup instructions",
      );
    }
    if (
      manifest.formatVersion !== 1 ||
      manifest.sourceRevision !== ZCODE_SOURCE_REVISION ||
      manifest.entry !== "worker.cjs" ||
      manifest.agent !== "agent/zcode.cjs" ||
      manifest.providerConfig !== "agent/provider/zcode-builtin.json"
    )
      throw new ZcodeError(
        "unsupported",
        "ZCode runtime does not match the supported source revision",
      );
    const entry = path.join(root, "worker.cjs");
    if (!(await stat(entry)).isFile())
      throw new ZcodeError("notInstalled", "ZCode service entry is missing");
    const nativeAgent = path.join(root, manifest.agent);
    const providerConfig = path.join(root, manifest.providerConfig);
    if (!(await stat(nativeAgent)).isFile() || !(await stat(providerConfig)).isFile())
      throw new ZcodeError(
        "notInstalled",
        "ZCode runtime is missing its Agent or Provider configuration",
      );
    const child = spawn(process.execPath, [entry], {
      cwd: this.options.cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.#child = child;
    child.stderr.resume();
    child.on("error", () =>
      this.#fail(new ZcodeError("unavailable", "Could not start ZCode local services")),
    );
    child.on("exit", (code) => {
      if (!this.#closed && !this.#closePromise)
        this.#fail(
          new ZcodeError("processExited", `ZCode local services exited (${code ?? "signal"})`),
        );
    });
    child.stdin.on("error", () => {
      if (!this.#closed && !this.#closePromise)
        this.#fail(new ZcodeError("processExited", "ZCode service input closed"));
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024)
        return this.#fail(new ZcodeError("protocolError", "ZCode response exceeded 64 MiB"));
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          this.#receive(record(JSON.parse(line)));
        } catch {
          this.#fail(new ZcodeError("protocolError", "Invalid ZCode service response"));
        }
      }
    });
    try {
      const initialized = record(
        await this.request("initialize", {
          cwd: this.options.cwd,
          nativeCommand: process.execPath,
          nativeArguments: [nativeAgent, "app-server", "--stdio", "--surface", "terminal"],
          providerConfig,
          clientId: this.clientId,
          verificationSupported: Boolean(this.options.openLocalPage),
        }),
      );
      if (initialized.protocol !== 1 || initialized.sourceRevision !== ZCODE_SOURCE_REVISION)
        throw new ZcodeError("protocolError", "ZCode service handshake did not match");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #receive(message: Record<string, unknown>) {
    if (this.#closed || this.#fault) return;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const code = record(message.error).code;
        const kind =
          code === -32601
            ? "unsupported"
            : code === -32602
              ? "invalidRequest"
              : code === -32004
                ? "sessionNotFound"
                : code === -32010
                  ? "sessionBusy"
                  : code === "ZCODE_AGENT_PROVIDER_NOT_READY"
                    ? "authenticationRequired"
                    : code === "protocolError"
                      ? "protocolError"
                      : "nativeFailure";
        const paths = record(message.error).schemaPaths;
        const schema = Array.isArray(paths)
          ? paths
              .filter(
                (p): p is string => typeof p === "string" && /^[A-Za-z0-9_.]{1,200}$/u.test(p),
              )
              .slice(0, 4)
              .join(", ")
          : "";
        pending.reject(
          new ZcodeError(
            kind,
            `ZCode native service rejected the operation (${String(code)}${schema ? `: ${schema}` : ""})`,
            kind === "sessionBusy",
          ),
        );
      } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new ZcodeError("protocolError", "ZCode service response has no result"));
    } else if (message.event === "verification.required") {
      const url = new URL(text(message.url));
      const requestId = text(message.requestId);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password ||
        !url.port ||
        url.pathname !== "/" ||
        url.hash ||
        !/^\?token=[A-Za-z0-9_-]{32}$/u.test(url.search) ||
        url.searchParams.get("token") !== requestId ||
        this.#pages.has(requestId) ||
        !this.options.openLocalPage
      )
        throw new Error("Invalid verification URL");
      const page = this.options.openLocalPage(url.href);
      this.#pages.set(requestId, page);
      void page.catch(() =>
        this.#fail(
          new ZcodeError("authenticationRequired", "Could not open the ZCode verification page"),
        ),
      );
    } else if (message.event === "verification.interactive") {
      const requestId = text(message.requestId);
      const page = this.#pages.get(requestId);
      void page
        ?.then(async (handle) => {
          if (!this.#closed && this.#pages.get(requestId) === page) await handle.show();
        })
        .catch(() =>
          this.#fail(new ZcodeError("unavailable", "Could not show ZCode verification")),
        );
    } else if (message.event === "verification.closed") {
      const requestId = text(message.requestId);
      const page = this.#pages.get(requestId);
      this.#pages.delete(requestId);
      void page?.then((handle) => handle.close()).catch(() => undefined);
    } else if (typeof message.key === "string" && typeof message.event === "string") {
      this.#listeners.get(message.key)?.(message.value);
    } else throw new Error("Invalid response");
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const child = this.#child;
    if (!child || this.#closed || this.#fault)
      return Promise.reject(
        this.#fault ?? new ZcodeError("invalidState", "ZCode service is closed"),
      );
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.#fail(
            new ZcodeError(
              "unavailable",
              "ZCode service request timed out; delivery is unconfirmed",
            ),
          ),
        this.options.timeoutMs ?? 30_000,
      );
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async listen(event: string, params: Record<string, unknown>, listener: (value: unknown) => void) {
    const key = randomUUID();
    this.#listeners.set(key, listener);
    try {
      await this.request("listen", { key, event, params });
    } catch (error) {
      this.#listeners.delete(key);
      throw error;
    }
    return async () => {
      this.#listeners.delete(key);
      await this.request("unlisten", { key });
    };
  }
  async command(
    sessionId: string | null,
    type: string,
    payload: unknown,
    commandId: string = randomUUID(),
    base?: { revision: number; logEpoch: string },
  ) {
    const result = record(
      await this.request("sendConversationCommandV4", {
        envelope: {
          commandId,
          clientId: this.clientId,
          sessionId,
          type,
          payload,
          issuedAt: Date.now(),
          ...(base ? { baseRevision: base.revision, baseLogEpoch: base.logEpoch } : {}),
        },
      }),
    );
    if (result.status !== "accepted") {
      const reason = text(result.reasonCode);
      const code = /^[A-Za-z][A-Za-z0-9_.-]{0,160}$/u.test(reason) ? `: ${reason}` : "";
      throw new ZcodeError(
        result.status === "stale" ? "sessionBusy" : "nativeFailure",
        `ZCode rejected ${type} (${text(result.status)}${code})`,
        result.status === "stale",
      );
    }
    return result;
  }
  #fail(error: Error) {
    if (this.#fault || this.#closed) return;
    this.#fault = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.onFault?.(error);
    void this.close();
  }
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }
  async #close() {
    const child = this.#child;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ZcodeError("invalidState", "ZCode service closed"));
    }
    this.#pending.clear();
    this.#listeners.clear();
    const pages = [...this.#pages.values()];
    this.#pages.clear();
    await Promise.allSettled(pages.map(async (page) => (await page).close()));
    if (!child) return;
    const wait = async (ms: number) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          child.off("exit", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        child.once("exit", finish);
      });
    };
    child.stdin.end();
    await wait(5000);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await wait(5000);
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        await new Promise<void>((resolve) => {
          killer.once("exit", () => resolve());
          killer.once("error", () => resolve());
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await wait(2000);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }
}
