import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";

import WebSocket from "ws";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function collectLines(stream) {
  const lines = [];
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) lines.push(line);
    }
  });
  return lines;
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const nodePath = requiredEnvironment("CODEXHOST_GATE_NODE");
const hostRuntimePath = requiredEnvironment("CODEXHOST_GATE_HOST_RUNTIME");
const stockCodexPath = requiredEnvironment("CODEXHOST_GATE_STOCK_CODEX");
const claudeCommand = requiredEnvironment("CODEXHOST_GATE_CLAUDE");
const remoteCodexPath = process.env.CODEXHOST_GATE_REMOTE_CODEX
  ? path.resolve(process.env.CODEXHOST_GATE_REMOTE_CODEX)
  : null;
const cwd = path.resolve(process.env.CODEXHOST_GATE_CWD ?? process.cwd());
const temporaryRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
const temporary = await mkdtemp(path.join(temporaryRoot, "ch-gate-"));
const codexHome = path.join(temporary, "codex-home");
const socketPath = path.join(codexHome, "app-server-control", "app-server-control.sock");
const environment = {
  ...process.env,
  CODEX_HOME: codexHome,
  CODEXHOST_DATA_DIR: path.join(temporary, "host-data"),
  CODEXHOST_STOCK_CODEX_PATH: stockCodexPath,
  CODEXHOST_DEFAULT_AGENT: "codex",
  CODEXHOST_CLAUDE_COMMAND: claudeCommand,
  PATH: `${path.dirname(nodePath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
};
const host = spawn(
  remoteCodexPath ?? nodePath,
  [
    ...(remoteCodexPath ? [] : [hostRuntimePath]),
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--listen",
    "unix://",
  ],
  { env: environment, stdio: ["ignore", "ignore", "pipe"] },
);
const hostDiagnostics = collectLines(host.stderr);
let proxy;
let client;
let secondProxy;
let secondClient;

try {
  await waitFor("remote app-server socket", async () => {
    const metadata = await stat(socketPath).catch(() => null);
    if (metadata?.isSocket()) return metadata;
    if (host.exitCode !== null || host.signalCode !== null) {
      throw new Error(`Host Runtime exited before listening: ${hostDiagnostics.join("\n")}`);
    }
    return undefined;
  });

  proxy = spawn(remoteCodexPath ?? stockCodexPath, ["app-server", "proxy", "--sock", socketPath], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const proxyDiagnostics = collectLines(proxy.stderr);
  const tunnel = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  client = new WebSocket("ws://localhost/", { createConnection: () => tunnel });
  const responses = [];
  let clientClose = null;
  client.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Remote app-server returned a binary frame");
    responses.push(JSON.parse(data.toString("utf8")));
  });
  client.on("close", (code, reason) => {
    clientClose = `${code} ${reason.toString("utf8")}`.trim();
  });
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  const assertTransportAlive = () => {
    if (proxy.exitCode !== null || proxy.signalCode !== null) {
      throw new Error(
        [
          `Codex app-server proxy exited (${proxy.exitCode ?? proxy.signalCode})`,
          `WebSocket close: ${clientClose ?? "not observed"}`,
          `Proxy diagnostics: ${proxyDiagnostics.join("\n") || "none"}`,
          `Host diagnostics: ${hostDiagnostics.join("\n") || "none"}`,
        ].join("\n"),
      );
    }
  };
  const takeMessage = (predicate) => {
    const index = responses.findIndex(predicate);
    return index < 0 ? undefined : responses.splice(index, 1)[0];
  };
  const request = async (id, method, params, timeoutMs = 30_000) => {
    client.send(JSON.stringify({ id, method, params }));
    const response = await waitFor(
      `${method} response`,
      async () => {
        assertTransportAlive();
        return takeMessage((message) => message.id === id);
      },
      timeoutMs,
    );
    if (response.error) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response;
  };
  const response = await request(31, "codexhost/harness/inspect", {
    harnessId: "claude-code",
    cwd,
    refresh: true,
  });
  if (response.error)
    throw new Error(`Harness inspection failed: ${JSON.stringify(response.error)}`);
  if (response.result?.status !== "ready") {
    throw new Error(`Claude Code Harness is not ready: ${JSON.stringify(response.result)}`);
  }

  secondProxy = spawn(
    remoteCodexPath ?? stockCodexPath,
    ["app-server", "proxy", "--sock", socketPath],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  const secondProxyDiagnostics = collectLines(secondProxy.stderr);
  const secondTunnel = Duplex.from({ readable: secondProxy.stdout, writable: secondProxy.stdin });
  secondClient = new WebSocket("ws://localhost/", { createConnection: () => secondTunnel });
  const secondResponses = [];
  secondClient.on("message", (data, isBinary) => {
    if (isBinary) throw new Error("Second remote app-server returned a binary frame");
    secondResponses.push(JSON.parse(data.toString("utf8")));
  });
  await new Promise((resolve, reject) => {
    secondClient.once("open", resolve);
    secondClient.once("error", reject);
  });
  secondClient.send(
    JSON.stringify({
      id: 32,
      method: "codexhost/harness/inspect",
      params: { harnessId: "claude-code", cwd, refresh: false },
    }),
  );
  const secondInspection = await waitFor(
    "concurrent Harness inspection",
    async () => {
      if (secondProxy.exitCode !== null || secondProxy.signalCode !== null) {
        throw new Error(
          `Concurrent proxy exited: ${secondProxyDiagnostics.join("\n") || "no diagnostics"}`,
        );
      }
      const index = secondResponses.findIndex((message) => message.id === 32);
      return index < 0 ? undefined : secondResponses.splice(index, 1)[0];
    },
    30_000,
  );
  if (secondInspection.error || secondInspection.result?.status !== "ready") {
    throw new Error(`Concurrent Harness inspection failed: ${JSON.stringify(secondInspection)}`);
  }
  secondClient.close();
  await stop(secondProxy);
  secondClient = undefined;
  secondProxy = undefined;

  const socketMode = (await stat(socketPath)).mode & 0o777;
  if (socketMode !== 0o600) {
    throw new Error(`Remote app-server socket mode is ${socketMode.toString(8)}, expected 600`);
  }

  const threadStart = await request(40, "thread/start", {
    model: "codexhost/claude-code-native",
    cwd,
  });
  const threadId = threadStart.result?.thread?.id;
  if (typeof threadId !== "string") throw new Error("Claude thread/start returned no Thread ID");
  const runTurn = async (id, text) => {
    const turnStart = await request(id, "turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    const turnId = turnStart.result?.turn?.id;
    if (typeof turnId !== "string") throw new Error("Claude turn/start returned no Turn ID");
    const completed = await waitFor(
      `turn/completed for ${turnId}`,
      async () => {
        assertTransportAlive();
        return takeMessage(
          (message) => message.method === "turn/completed" && message.params?.turn?.id === turnId,
        );
      },
      120_000,
    );
    if (completed.params?.turn?.status !== "completed") {
      throw new Error(`Claude Turn did not complete: ${JSON.stringify(completed.params?.turn)}`);
    }
  };
  await runTurn(41, "Remember the token CEDAR-482. Reply with exactly READY.");
  await runTurn(42, "Reply with only the token I asked you to remember in the previous turn.");
  const threadRead = await request(43, "thread/read", { threadId, includeTurns: true });
  const turns = threadRead.result?.thread?.turns;
  if (!Array.isArray(turns) || turns.length < 2) {
    throw new Error(`Claude thread/read returned incomplete history: ${JSON.stringify(turns)}`);
  }
  const assistantTexts = turns.map((turn) =>
    (turn.items ?? [])
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .join(""),
  );
  if (!assistantTexts[0]?.includes("READY") || !assistantTexts[1]?.includes("CEDAR-482")) {
    throw new Error(`Claude context continuity failed: ${JSON.stringify(assistantTexts)}`);
  }
  console.log(
    JSON.stringify(
      {
        status: "ready",
        socketMode: socketMode.toString(8),
        claudeStatus: response.result.status,
        modelCount: response.result.catalog?.models?.length ?? 0,
        contextRetained: true,
        concurrentConnections: 2,
        turnCount: turns.length,
        entrypoint: remoteCodexPath ? "managed-wrapper" : "host-runtime",
        cwd,
      },
      null,
      2,
    ),
  );
} finally {
  if (client?.readyState === WebSocket.OPEN) client.close();
  if (secondClient?.readyState === WebSocket.OPEN) secondClient.close();
  if (secondProxy) await stop(secondProxy);
  if (proxy) await stop(proxy);
  await stop(host);
  await rm(temporary, { recursive: true, force: true });
}
