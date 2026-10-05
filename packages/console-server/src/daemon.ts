import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

import WebSocket from "ws";

const DAEMON_ARGUMENT = "--codexhost-daemon";

interface RuntimeDescriptor {
  schemaVersion: 1;
  protocolVersion: 1;
  pid: number;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  startedAt: number | null;
  runtimePath: string | null;
  error: string | null;
}

export interface ConsoleDaemon {
  status(): Promise<DaemonStatus>;
  start(): Promise<DaemonStatus>;
  stop(): Promise<DaemonStatus>;
  restart(): Promise<DaemonStatus>;
}

function validDescriptor(value: unknown): value is RuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    d.protocolVersion === 1 &&
    d.host === "127.0.0.1" &&
    typeof d.pid === "number" &&
    typeof d.port === "number" &&
    typeof d.token === "string" &&
    typeof d.startedAt === "number"
  );
}

async function descriptor(file: string): Promise<RuntimeDescriptor | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return validDescriptor(value) ? value : null;
  } catch {
    return null;
  }
}

function runtimePath(appDirectory: string, environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEXHOST_HOST_RUNTIME_PATH;
  if (configured && path.isAbsolute(configured)) return configured;
  if (
    path.basename(appDirectory) === "dist" &&
    path.basename(path.dirname(appDirectory)) === "console-server"
  ) {
    return path.resolve(appDirectory, "..", "..", "host-runtime", "dist", "main.js");
  }
  return path.join(appDirectory, "host-runtime.mjs");
}

function probe(d: RuntimeDescriptor): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://${d.host}:${d.port}/`, {
      headers: { authorization: `Bearer ${d.token}` },
      handshakeTimeout: 1_500,
    });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Ignore.
      }
      resolve(ok);
    };
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForStatus(
  read: () => Promise<DaemonStatus>,
  running: boolean,
  timeoutMs: number,
): Promise<DaemonStatus> {
  const deadline = Date.now() + timeoutMs;
  let current = await read();
  while (current.running !== running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await read();
  }
  return current;
}

export function createConsoleDaemon(options: {
  appDirectory: string;
  dataDirectory: string;
  logsDirectory: string;
  environment?: NodeJS.ProcessEnv;
}): ConsoleDaemon {
  const environment = options.environment ?? process.env;
  const descriptorPath = path.join(options.dataDirectory, "runtime.json");
  const hostRuntimePath = runtimePath(options.appDirectory, environment);
  const readStatus = async (): Promise<DaemonStatus> => {
    const current = await descriptor(descriptorPath);
    if (!current) {
      return {
        running: false,
        pid: null,
        port: null,
        startedAt: null,
        runtimePath: hostRuntimePath,
        error: null,
      };
    }
    const running = await probe(current);
    return {
      running,
      pid: running ? current.pid : null,
      port: running ? current.port : null,
      startedAt: running ? current.startedAt : null,
      runtimePath: hostRuntimePath,
      error: running ? null : "stale runtime descriptor",
    };
  };

  const start = async (): Promise<DaemonStatus> => {
    const current = await readStatus();
    if (current.running) return current;
    if (current.error) await rm(descriptorPath, { force: true }).catch(() => undefined);

    await mkdir(options.logsDirectory, { recursive: true });
    const logPath = path.join(options.logsDirectory, "daemon.log");
    const log = await open(logPath, "a");
    const child = spawn(process.execPath, [hostRuntimePath, DAEMON_ARGUMENT], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
      env: environment,
    });
    child.unref();
    await log.close();

    const ready = await waitForStatus(readStatus, true, 10_000);
    if (!ready.running) throw new Error(ready.error ?? "codexhost daemon did not start");
    return ready;
  };

  const stop = async (): Promise<DaemonStatus> => {
    const current = await readStatus();
    if (!current.running || current.pid === null) {
      if (current.error) await rm(descriptorPath, { force: true }).catch(() => undefined);
      return { ...current, error: null };
    }
    process.kill(current.pid, "SIGTERM");
    // Listener shutdown precedes Mapping Store release. A restart must wait
    // for process exit as well, otherwise the replacement races the old lock.
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        process.kill(current.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error("codexhost daemon did not stop");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stopped = await readStatus();
    if (stopped.running) throw new Error("codexhost daemon did not stop");
    return { ...stopped, error: null };
  };

  return {
    status: readStatus,
    start,
    stop,
    async restart() {
      await stop();
      return start();
    },
  };
}
