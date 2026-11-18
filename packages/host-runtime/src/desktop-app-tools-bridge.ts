import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { APP_TOOLS_LAUNCHER_PATH, findDesktopAppTools } from "./desktop-app-tools.js";
import { DESKTOP_APP_TOOLS_PIPE_ENV } from "./desktop-context-environment.js";
import { desktopStdioConfig } from "./desktop-mcp-config.js";

const MCP_NODE_PATH = "CODEX_MCP_NODE_PATH";
const run = promisify(execFile);

/** Starts the original bundled plugin after kernel-authenticated admission to Desktop. */
export async function createDesktopAppToolsBridge(options: {
  launcher: string;
  hostPid: number;
  stockCodex: string;
  runtimePath: string;
  resourcesPath: string;
  environment: NodeJS.ProcessEnv;
}) {
  const appTools = findDesktopAppTools(options.resourcesPath, options.environment);
  if (!appTools || typeof process.execve !== "function") return;
  const { entry, cwd, pipe, codexHome, matches } = appTools;
  let identity: string;
  let codex: string;
  let node: string;
  try {
    const [host, executable, runtime] = await Promise.all([
      run(options.launcher, ["--desktop-mcp-peer", "identify", String(options.hostPid)], {
        timeout: 5_000,
      }),
      realpath(options.stockCodex),
      realpath(process.execPath),
    ]);
    identity = host.stdout.trim();
    if (!/^\d+$/u.test(identity)) return;
    codex = executable;
    node = runtime;
  } catch {
    return;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "ch-app-"));
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<void>>();
  let closed = false;
  async function serve(socket: Socket, deferred: string): Promise<void> {
    const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
    if (fd === undefined || fd < 0) return;
    const check = spawn(
      options.launcher,
      ["--desktop-mcp-peer", "authorize", String(options.hostPid), identity, codex, node],
      { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5_000 },
    );
    const [status] = await once(check, "exit");
    if (status !== 0 || closed || socket.destroyed) return;

    const child = spawn(
      node,
      [options.runtimePath, "--codexhost-desktop-mcp-server", node, entry],
      {
        cwd,
        env: { [DESKTOP_APP_TOOLS_PIPE_ENV]: pipe, CODEX_APP_TOOLS_DEFERRED: deferred },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    socket.once("close", () => child.kill());
    child.stdin.on("error", () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    await once(child, "close");
  }
  const servers = ["0", "1"].map((deferred) => {
    const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
      if (closed || sockets.size >= 64) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      const operation = serve(socket, deferred)
        .catch(() => {})
        .finally(() => {
          if (!socket.destroyed) socket.end();
          operations.delete(operation);
        });
      operations.add(operation);
    });
    return { server, endpoint: path.join(directory, deferred) };
  });
  async function close(): Promise<void> {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        ({ server }) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(operations);
    await rm(directory, { recursive: true, force: true });
  }
  const wrapper = path.join(directory, "node");
  try {
    await Promise.all(
      servers.map(async ({ server, endpoint }) => {
        server.listen(endpoint);
        await once(server, "listening");
      }),
    );
    const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
    const invocation = [
      node,
      options.runtimePath,
      "--codexhost-desktop-app-tools-client",
      directory,
      options.resourcesPath,
      codexHome,
    ]
      .map(quote)
      .join(" ");
    await writeFile(
      wrapper,
      `#!/bin/sh
export ${MCP_NODE_PATH}=${quote(node)}
if [ "$#" -eq 1 ]; then
  case "$1" in server.mjs|*/server.mjs) exec ${invocation} "$1";; esac
fi
exec ${quote(node)} "$@"
`,
      { mode: 0o700 },
    );
    return { wrapper, matches, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The stock plugin still selects its own transport using CODEX_MCP_NODE_PATH. */
export async function runDesktopAppToolsClient(arguments_: string[]): Promise<number> {
  const [directory, resourcesPath, codexHome, ...args] = arguments_;
  if (!directory || !resourcesPath || !codexHome || args.length !== 1) return 1;
  const cwd = process.cwd();
  const definition = desktopStdioConfig.parse({
    command: path.join(cwd, APP_TOOLS_LAUNCHER_PATH),
    cwd,
    args,
  });
  const selected = findDesktopAppTools(resourcesPath, { ...process.env, CODEX_HOME: codexHome });
  if (!selected?.matches(definition)) {
    process.execve?.(process.execPath, [process.execPath, ...args], process.env);
    return 1;
  }
  const socket = createConnection(
    path.join(directory, process.env.CODEX_APP_TOOLS_DEFERRED === "1" ? "1" : "0"),
  );
  const result = Promise.withResolvers<number>();
  socket.once("error", () => result.resolve(1));
  socket.once("close", () => result.resolve(0));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout, { end: false });
  try {
    return await result.promise;
  } finally {
    process.stdin.unpipe(socket);
    process.stdin.pause();
    socket.destroy();
  }
}
