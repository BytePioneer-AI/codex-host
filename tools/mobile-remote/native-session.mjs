import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { createRemoteOfficialAppServerConnection } from "../../packages/host-runtime/dist/remote-official-connection.js";

/** Launch only this caller's isolated app-server; never discover a production daemon. */
export async function startNativeServer({
  binary,
  home,
  hostSocket,
  environment = {},
  testMode = false,
  cliMode = false,
  diagnosticFile,
  onMessage,
}) {
  const token = randomBytes(32).toString("base64url");
  let socket;
  let endpoint;
  let stderr = "";
  let sequence = 0;
  let closing;
  const pending = new Map();
  if (diagnosticFile) await writeFile(diagnosticFile, "", { mode: 0o600 });
  const child = spawn(
    binary,
    [
      ...(cliMode ? ["app-server"] : []),
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      createHash("sha256").update(token).digest("hex"),
      "--remote-control",
      ...(testMode && !cliMode ? ["--disable-plugin-startup-tasks-for-tests"] : []),
    ],
    {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CODEX_HOME: home,
        CODEXHOST_REMOTE_HOST_SOCKET: hostSocket,
        NO_COLOR: "1",
        RUST_LOG: "warn",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const fail = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  let exited = false;
  let spawnError;
  const exit = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
      fail(error);
      resolve();
    });
    child.once("exit", () => {
      exited = true;
      fail(new Error("Isolated app-server exited"));
      resolve();
    });
  });
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    endpoint ??= stderr.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (diagnosticFile) void appendFile(diagnosticFile, chunk).catch(() => {});
  });
  const awaitExit = async (milliseconds) => {
    let timer;
    try {
      return await Promise.race([
        exit.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      fail(new Error("Isolated app-server closing"));
      socket?.terminate();
      let forced = false;
      if (!exited && child.pid) {
        child.kill("SIGTERM");
        if (!(await awaitExit(10000))) {
          forced = true;
          child.kill("SIGKILL");
          await awaitExit(5000);
        }
      }
      return { exitCode: child.exitCode, signal: child.signalCode, forced, exited };
    })();
    return closing;
  };
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN)
        return reject(new Error("Private native WebSocket is closed"));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native request timed out: ${method}`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  try {
    const deadline = Date.now() + 60000;
    while (!endpoint) {
      if (exited)
        throw new Error(
          `Isolated app-server startup failed${spawnError ? `: ${spawnError.message}` : ""}; inspect private diagnostic log`,
        );
      if (Date.now() >= deadline) throw new Error("Isolated app-server startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      handshakeTimeout: 5000,
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Private native WebSocket closed")));
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        onMessage?.(message);
        if (!message.method && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error)
            entry.reject(new Error(`Native RPC ${message.error.code}: ${message.error.message}`));
          else entry.resolve(message.result);
        }
      } catch (error) {
        fail(error);
        socket.terminate();
      }
    });
    await once(socket, "open");
    await request("initialize", {
      clientInfo: { name: "codexhost-mobile-isolated-validation", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send('{"method":"initialized"}');
    return {
      request,
      close,
      closed: exit,
      pid: child.pid,
      connect: () => createRemoteOfficialAppServerConnection(endpoint, { capabilityToken: token }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
