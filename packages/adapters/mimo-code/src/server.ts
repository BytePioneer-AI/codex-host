import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createOpencodeClient as createMimoClient,
  type OpencodeClient,
} from "@mimo-ai/sdk/v2/client";
import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";
import { bounded, checked, MimoError } from "./protocol.js";

export interface MimoConnection {
  client: OpencodeClient;
  exited: Promise<void>;
  close(): Promise<void>;
}
export interface ServerOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  command?: string;
}
export type Connect = (options: ServerOptions) => Promise<MimoConnection>;

/** Carries ownership back to the Adapter when startup cleanup cannot finish. */
export class MimoCleanupError extends MimoError {
  constructor(readonly close: () => Promise<void>) {
    super("unavailable", "MiMo service cleanup failed; an owned process may still be running");
  }
}

export const connectMimo: Connect = async (options) => {
  const resolution = resolveHarnessExecutable(
    {
      id: "mimo-code",
      command: "mimo",
      commandEnvironmentVariable: "CODEXHOST_MIMO_COMMAND",
      installRoots: { windows: ["~/.mimocode/bin"], posix: ["~/.mimocode/bin"] },
    },
    { environment: options.environment, ...(options.command ? { command: options.command } : {}) },
  );
  if (!resolution) throw new MimoError("notInstalled", "MiMo Code CLI is not installed");
  const password = randomBytes(32).toString("base64url");
  const environment = {
    ...options.environment,
    MIMOCODE_SERVER_USERNAME: "codexhost",
    MIMOCODE_SERVER_PASSWORD: password,
  };
  const invocation = commandInvocation(
    resolution.executable,
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    environment,
  );
  const child = spawn(invocation.command, invocation.arguments, {
    cwd: options.cwd,
    env: environment,
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      lifetime.abort();
      await stopProcess(child, exited);
    })().catch((error) => {
      closing = undefined;
      throw error;
    }));
  try {
    const address = await bounded(
      new Promise<string>((resolve, reject) => {
        let buffer = "";
        child.stdout.on("data", (data: Buffer) => {
          buffer = (buffer + data.toString()).slice(-8192);
          const match = buffer.match(
            /(?:^|\n)mimocode server listening on (http:\/\/127\.0\.0\.1:(\d+))\s*(?:\r?\n|$)/u,
          );
          if (match?.[1] && Number(match[2]) > 0 && Number(match[2]) <= 65535) resolve(match[1]);
        });
        // Drain diagnostics without retaining secrets or native config.
        child.stderr.resume();
        child.once("error", () =>
          reject(new MimoError("unavailable", "MiMo service failed to start")),
        );
        child.once("exit", () => reject(new MimoError("processExited", "MiMo service exited")));
      }),
      20_000,
      "MiMo service startup timed out",
    );
    const client = createMimoClient({
      baseUrl: address,
      directory: options.cwd,
      headers: {
        Authorization: `Basic ${Buffer.from(`codexhost:${password}`).toString("base64")}`,
      },
      fetch: async (request) => {
        const input = request instanceof Request ? request : new Request(request);
        const pathname = new URL(input.url).pathname;
        const longRunning =
          pathname === "/event" ||
          (input.method === "POST" && /^\/session\/[^/]+\/message$/u.test(pathname));
        const signal = AbortSignal.any([
          input.signal,
          lifetime.signal,
          ...(longRunning ? [] : [AbortSignal.timeout(20_000)]),
        ]);
        return fetch(new Request(input, { signal, redirect: "error" }));
      },
    });
    const health = checked(await client.global.health());
    if (!health.healthy) {
      throw new MimoError("unavailable", "MiMo service health check failed");
    }
    if (!["0.1.14", "0.1.15"].includes(health.version)) {
      throw new MimoError(
        "unsupported",
        `MiMo integration supports native CLI 0.1.14 or 0.1.15; received ${health.version}`,
      );
    }
    return { client, exited, close };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new MimoCleanupError(close);
    }
    throw error;
  }
};

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<void>,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await bounded(
      new Promise<void>((resolve) => {
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      }),
      5_000,
      "MiMo process tree cleanup timed out",
    );
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  try {
    await bounded(exited, 3_000, "MiMo service has not exited");
  } catch {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else child.kill();
    await bounded(exited, 3_000, "MiMo service cleanup could not confirm exit");
  }
}
