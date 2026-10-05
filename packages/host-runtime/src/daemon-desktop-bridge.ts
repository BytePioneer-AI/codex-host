import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Transform, type TransformCallback, type Writable } from "node:stream";

import { createRemoteOfficialAppServerConnection } from "./remote-official-connection.js";

const ATTACH_ID = "codexhost-daemon-attach";

export function daemonDesktopSocketPath(environment: NodeJS.ProcessEnv): string {
  return path.join(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex"),
    "app-server-control",
    "codexhost-daemon-desktop.sock",
  );
}

export async function daemonDesktopAvailable(environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (process.platform === "win32") return false;
  const socketPath = daemonDesktopSocketPath(environment);
  const metadata = await lstat(socketPath).catch(() => null);
  if (!metadata || !metadata.isSocket()) return false;
  if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Daemon Desktop socket must be private and owned by the current user");
  }
  const connection = await createRemoteOfficialAppServerConnection(socketPath).catch(() => null);
  if (!connection) return false;
  connection.close();
  return true;
}

class AttachResponseFilter extends Transform {
  #pending = Buffer.alloc(0);
  readonly attached = Promise.withResolvers<undefined>();

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    try {
      while (true) {
        const newline = this.#pending.indexOf(0x0a);
        if (newline < 0) break;
        const frame = this.#pending.subarray(0, newline);
        this.#pending = this.#pending.subarray(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(frame.toString("utf8"));
        } catch {
          this.push(Buffer.concat([frame, Buffer.from("\n")]));
          continue;
        }
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { id?: unknown }).id === ATTACH_ID
        ) {
          const record = message as { error?: { message?: unknown } };
          if (record.error) {
            this.attached.reject(
              new Error(
                typeof record.error.message === "string"
                  ? record.error.message
                  : "Daemon runtime attach failed",
              ),
            );
          } else {
            this.attached.resolve(undefined);
          }
          continue;
        }
        this.push(Buffer.concat([frame, Buffer.from("\n")]));
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.#pending.length > 0) this.push(this.#pending);
    callback();
  }
}

export async function runDaemonDesktopBridge(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  stockCodexPath: string;
  defaultAgent: "codex" | "pi";
  diagnosticOutput?: Writable;
}): Promise<number> {
  const diagnosticOutput = input.diagnosticOutput ?? process.stderr;
  const connection = await createRemoteOfficialAppServerConnection(
    daemonDesktopSocketPath(input.environment),
  );
  connection.stderr.pipe(diagnosticOutput, { end: false });

  const filter = new AttachResponseFilter();
  connection.stdout.pipe(filter).pipe(process.stdout, { end: false });
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        connection.stdin.write(
          Buffer.from(
            `${JSON.stringify({
              id: ATTACH_ID,
              method: "codexhost/runtime/attach",
              params: {
                stockCodexPath: input.stockCodexPath,
                arguments: input.arguments,
                defaultAgent: input.defaultAgent,
              },
            })}\n`,
          ),
          (error) => (error ? reject(error) : resolve()),
        );
      }),
      Promise.race([
        filter.attached.promise,
        connection.closed.then((result) => {
          throw (
            result.error ?? new Error("Daemon Desktop connection closed before attach completed")
          );
        }),
      ]),
    ]);
  } catch (error) {
    connection.close();
    throw error;
  }

  process.title = "codexhost desktop bridge";
  process.stdin.pipe(connection.stdin);

  const close = (): void => connection.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    const result = await connection.closed;
    if (result.error) throw result.error;
    return result.signal ? 1 : (result.code ?? 0);
  } finally {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}
