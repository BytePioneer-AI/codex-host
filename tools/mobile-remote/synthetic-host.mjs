// Isolated acceptance fixture: production Host composition, public Fake Harness contract.
import { mkdtemp, rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { MappingStore } from "@codexhost/mapping-store";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { startLocalSharedHost } from "../../packages/host-runtime/dist/local-shared-host.js";

export async function connectHost(socketPath, name, requestTimeoutMs = 5000) {
  const socket = new WebSocket("ws://localhost/", {
    perMessageDeflate: false,
    createConnection: () => net.createConnection(socketPath),
  });
  const messages = [];
  const pending = new Map();
  let sequence = 0;
  const fail = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Test Host disconnected"));
    }
    pending.clear();
  };
  socket.on("error", fail);
  socket.on("close", fail);
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    if (!message.method && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error)
        entry.reject(new Error(`Host RPC ${message.error.code}: ${message.error.message}`));
      else entry.resolve(message.result);
    }
  });
  await Promise.race([
    once(socket, "open"),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Test Host handshake timeout")), 5000);
      timer.unref();
    }),
  ]);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Host request timeout: ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await request("initialize", {
    clientInfo: { name, version: "1" },
    capabilities: { experimentalApi: true },
  });
  return {
    request,
    messages,
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const done = once(socket, "close");
      socket.close();
      await done;
    },
  };
}

export async function startSyntheticHost({
  createOfficialConnection,
  onReady,
  allowAdditionalSessions = false,
} = {}) {
  const directory = await mkdtemp("/tmp/ch-mobile-live-");
  const socketPath = path.join(directory, "host.sock");
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
  const nativeCalls = [];
  const diagnostics = new PassThrough();
  diagnostics.on("data", (chunk) => {
    if (process.env.CODEXHOST_PROBE_DIAGNOSTICS) process.stderr.write(chunk);
  });
  let runtime;
  let desktop;
  try {
    runtime = await startLocalSharedHost({
      socketPath,
      common: {
        stockCodexPath: "/nonexistent/synthetic-fixture",
        arguments: [],
        externalOnly: !createOfficialConnection,
        environment: {
          HOME: directory,
          CODEX_HOME: path.join(directory, "codex"),
          CODEXHOST_DATA_DIR: directory,
        },
        mappingStore: new MappingStore({ directory: path.join(directory, "store") }),
        externalAdapters: new Map([["pi", adapter]]),
        diagnosticOutput: diagnostics,
        createOfficialConnection: () => {
          nativeCalls.push(true);
          if (createOfficialConnection) return createOfficialConnection();
          throw new Error("Synthetic Host forbids native backend");
        },
      },
    });
    await onReady?.(socketPath, adapter);
    desktop = await connectHost(socketPath, "synthetic-desktop");
    const { thread } = await desktop.request("thread/start", {
      model: "codexhost/pi-native",
      cwd: directory,
    });
    const title = `CodexHost 手机验证（合成）${thread.id.slice(-8)}`;
    await desktop.request("thread/name/set", { threadId: thread.id, name: title });
    await desktop.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Synthetic acceptance history." }],
    });
    const session = adapter.sessions[0];
    session.appendText("Synthetic native history from the shared owner.");
    session.succeedTurn();
    // read acts as a request barrier; poll only the synthetic completed state.
    let history;
    for (let i = 0; i < 50; i++) {
      history = await desktop.request("thread/read", { threadId: thread.id, includeTurns: true });
      if (history.thread.turns.at(-1)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (history.thread.turns.at(-1)?.status !== "completed")
      throw new Error("Synthetic history did not complete");
    return {
      directory,
      socketPath,
      threadId: thread.id,
      title,
      adapter,
      desktop,
      async close() {
        await desktop.close();
        await runtime.close();
        if (
          (!createOfficialConnection && nativeCalls.length) ||
          (!allowAdditionalSessions && adapter.sessions.length !== 1)
        )
          throw new Error("Synthetic owner isolation failed");
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await desktop?.close();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
