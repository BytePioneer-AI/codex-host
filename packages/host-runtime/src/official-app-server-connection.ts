import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { OfficialProcessLifecycle } from "./official-process-lifecycle.js";

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
  readonly processId?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Logical connection closure; for a remote socket this does not prove process exit. */
  readonly closed: Promise<OfficialAppServerExit>;
  /** Only present when this connection owns its child process. */
  stopProcess?(): Promise<OfficialAppServerExit>;
  close(): void;
}

export function spawnOfficialAppServerConnection(input: {
  stockCodexPath: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  cwd?: string;
  spawnOfficial?: typeof spawn;
  closeTimeoutMs?: number;
}): OfficialAppServerConnection {
  const spawnOfficial = input.spawnOfficial ?? spawn;
  const child = spawnOfficial(input.stockCodexPath, input.arguments, {
    env: input.environment,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const lifecycle = new OfficialProcessLifecycle(child, {
    ...(input.closeTimeoutMs === undefined ? {} : { timeoutMs: input.closeTimeoutMs }),
    endInput: () => child.stdin.end(),
  });

  return {
    ...(child.pid === undefined ? {} : { processId: child.pid }),
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    closed: lifecycle.closed,
    stopProcess: () => lifecycle.stop(),
    close() {
      child.stdin.destroy();
      lifecycle.requestClose();
    },
  };
}
