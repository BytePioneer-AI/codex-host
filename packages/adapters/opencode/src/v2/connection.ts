import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import { openCodeServerInvocation, resolveOpenCodeExecutable } from "../command.js";
import type { OpenCodeServerOptions } from "../server-connection.js";

/** One foreground server per Session; never attach to the user's shared v2 service. */
export class V2Connection {
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<OpenCodeClient> | undefined;
  #closing: Promise<void> | undefined;
  #abort = new AbortController();
  #stderr = "";
  constructor(
    readonly options: OpenCodeServerOptions,
    readonly cwd: string,
  ) {}

  get stderrTail() {
    return this.#stderr;
  }

  client(): Promise<OpenCodeClient> {
    if (this.#closing) return Promise.reject(new Error("OpenCode v2 connection is closed"));
    return (this.#starting ??= this.#start());
  }

  async #start(): Promise<OpenCodeClient> {
    const password = randomBytes(32).toString("base64url");
    const env = {
      ...(this.options.environment ?? process.env),
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
    };
    const executable = resolveOpenCodeExecutable({
      ...(this.options.command ? { command: this.options.command } : {}),
      environment: env,
    });
    const invocation = openCodeServerInvocation(executable, env);
    const child = spawn(invocation.command, invocation.arguments, {
      env,
      cwd: this.cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = sanitizeDiagnosticTail(this.#stderr + chunk.toString());
    });
    try {
      const baseUrl = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out")),
          this.options.startupTimeoutMs ?? 20_000,
        );
        const abort = () => finish(new Error("OpenCode v2 connection closed during startup"));
        const finish = (error?: Error, url?: string) => {
          clearTimeout(timer);
          this.#abort.signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else if (url) resolve(url);
        };
        this.#abort.signal.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => finish(error));
        child.once("exit", (code, signal) =>
          finish(new Error(`OpenCode v2 server exited (${signal ?? code})`)),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const lines = output.split(/\r?\n/u);
          output = (lines.pop() ?? "").slice(-8192);
          for (const line of lines) {
            const url = /^server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/u.exec(line)?.[1];
            if (url) finish(undefined, url);
          }
        });
      });
      const client = OpenCode.make({
        baseUrl,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: (request, init) => {
          const signal = AbortSignal.any([
            this.#abort.signal,
            ...(init?.signal ? [init.signal] : []),
            // Event streams keep their caller-owned lifetime; ordinary requests are bounded.
            ...((request instanceof Request ? request.url : String(request)).includes("/event")
              ? []
              : [AbortSignal.timeout(this.options.commandTimeoutMs ?? 20_000)]),
          ]);
          return fetch(request, { ...init, signal });
        },
      });
      const info = await client.server.info();
      if (!/^2\./u.test(info.version))
        throw new Error(`Expected OpenCode v2 server, received ${info.version}`);
      return client;
    } catch (error) {
      await this.#stop();
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#abort.abort();
      await this.#stop();
      await this.#starting?.catch(() => undefined);
    })());
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    if (!child?.pid) return;
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32")
          spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else process.kill(-pid, signal);
      } catch {
        /* Already exited. */
      }
    };
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          kill("SIGKILL");
          resolve();
        }, this.options.closeTimeoutMs ?? 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        kill("SIGTERM");
      });
    }
    if (this.#child === child) this.#child = undefined;
  }
}
