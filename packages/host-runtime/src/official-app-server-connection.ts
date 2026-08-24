import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface OfficialAppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * One logical Codex app-server client connection.
 *
 * Local Host Runtime invocations own a child process. Remote Host Runtime
 * sessions instead connect to one shared official listener, but expose the
 * same LF-delimited byte streams to AppServerHost.
 */
export interface OfficialAppServerConnection {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly closed: Promise<OfficialAppServerExit>;
  close(): void;
}

export function spawnOfficialAppServerConnection(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  spawnOfficial?: typeof spawn;
}): OfficialAppServerConnection {
  const spawnOfficial = input.spawnOfficial ?? spawn;
  const child = spawnOfficial(input.stockCodexPath, input.arguments, {
    env: input.environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const closed = Promise.withResolvers<OfficialAppServerExit>();
  child.once("error", (error) => closed.resolve({ code: null, signal: null, error }));
  child.once("exit", (code, signal) => closed.resolve({ code, signal }));

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    closed: closed.promise,
    close() {
      child.stdin.destroy();
      child.kill("SIGTERM");
    },
  };
}
