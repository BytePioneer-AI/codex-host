// Test-only facade: never installed in the production Host or Desktop.
import net from "node:net";
import { appendFile, chmod, rm } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
import { encodePiTransportModel } from "@codexhost/protocol-core";

export function probeModels(template, secondModel) {
  return [
    {
      ...template,
      id: "phone-probe-id-a",
      model: "codexhost/pi-native",
      displayName: "测试 A · 可读模型名称",
      description: "Synthetic phone picker probe A",
      isDefault: true,
      hidden: false,
    },
    {
      ...template,
      id: "phone-probe-id-b",
      model: encodePiTransportModel(secondModel),
      displayName: "测试 B · 另一模型名称",
      description: "Synthetic phone picker probe B",
      isDefault: false,
      hidden: false,
    },
  ];
}

export function pickerObservation(message) {
  if (!message.method) return undefined;
  const params = message.params ?? {};
  const fields = {};
  for (const key of [
    "model",
    "modelProvider",
    "threadId",
    "effort",
    "reasoningEffort",
    "serviceTier",
    "cursor",
    "limit",
    "includeHidden",
  ])
    if (["string", "number", "boolean"].includes(typeof params[key]) || params[key] === null)
      fields[key] = params[key];
  return { method: message.method, parameterKeys: Object.keys(params), fields };
}

export function pickerConfigObservation(result) {
  const config = result?.config ?? {};
  return {
    model: config.model ?? null,
    sandboxMode: config.sandbox_mode ?? null,
    approvalPolicy: config.approval_policy ?? null,
    projectTrust: Object.values(config.projects ?? {}).map(
      (project) => project?.trust_level ?? null,
    ),
    layerTypes: (result?.layers ?? []).map((layer) => layer.name?.type),
  };
}

export async function configureReadonlyProbe(native, cwd) {
  const result = await native.request("config/batchWrite", {
    edits: [{ keyPath: "sandbox_mode", mergeStrategy: "replace", value: "read-only" }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (result.status !== "ok") throw new Error("Isolated read-only configuration was not accepted");
  const effective = await native.request("config/read", { cwd, includeLayers: true });
  if (effective.config.sandbox_mode !== "read-only")
    throw new Error("Isolated read-only configuration was not effective");
  return pickerConfigObservation(effective);
}

export async function startModelPickerProbe({ upstream, socketPath, adapter, report }) {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const http = await import("node:http").then(({ createServer }) => createServer());
  const sockets = new Set();
  const observations = [];
  let recording = Promise.resolve();
  const log = (entry) => {
    observations.push(entry);
    recording = recording.then(() =>
      appendFile(report, JSON.stringify(entry) + "\n", { mode: 0o600 }),
    );
    // Keep failures observable without unhandled promise rejection.
    void recording.catch(() => {});
  };
  http.on("upgrade", (request, socket, head) =>
    server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws)),
  );
  server.on("connection", (client) => {
    const backend = new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => net.createConnection(upstream),
    });
    sockets.add(client);
    sockets.add(backend);
    const pending = new Map();
    const queued = [];
    const close = () => {
      client.terminate();
      backend.terminate();
      sockets.delete(client);
      sockets.delete(backend);
    };
    client.on("error", close);
    backend.on("error", close);
    client.on("close", close);
    backend.on("close", close);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const observation = pickerObservation(message);
      if (observation) log(observation);
      if (message.method && message.id !== undefined) pending.set(message.id, message.method);
      if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary: false });
      else queued.push(data);
    });
    backend.on("open", () => {
      for (const frame of queued.splice(0)) backend.send(frame, { binary: false });
    });
    backend.on("message", (data) => {
      const message = JSON.parse(data.toString());
      const method = pending.get(message.id);
      if (!message.method) pending.delete(message.id);
      if (method === "model/list" && message.result?.data?.length) {
        const models = probeModels(message.result.data[0], adapter.catalog.models[1].ref);
        message.result = { ...message.result, data: models, nextCursor: null };
        log({
          response: method,
          models: models.map(({ id, model, displayName }) => ({ id, model, displayName })),
        });
      }
      if (method === "config/read")
        log({
          response: method,
          config: pickerConfigObservation(message.result),
          errorCode: message.error?.code,
        });
      if (method === "config/batchWrite")
        log({ response: method, status: message.result?.status, errorCode: message.error?.code });
      if (method === "thread/start" || method === "thread/resume")
        log({ response: method, model: message.result?.model, errorCode: message.error?.code });
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
    });
  });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    observations,
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => http.close(resolve));
      await rm(socketPath, { force: true });
      await recording;
    },
  };
}

export function installSyntheticReplies(adapter) {
  const timers = new Set();
  const wrap = (session) => {
    const execute = session.execute.bind(session);
    session.execute = async (command) => {
      const result = await execute(command);
      if (command.type === "turn.start" && result.ok) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (session.closed) return;
          try {
            session.appendText(
              "模型选择协议探针：这是合成回复，没有调用真实模型。选择请求已记录。",
            );
            session.succeedTurn();
          } catch {
            /* A cancellation may have already completed this synthetic Turn. */
          }
        }, 100);
        timers.add(timer);
      }
      return result;
    };
  };
  for (const session of adapter.sessions) wrap(session);
  const open = adapter.open.bind(adapter);
  adapter.open = async (input) => {
    const result = await open(input);
    if (result.ok) wrap(result.value);
    return result;
  };
  return () => {
    for (const timer of timers) clearTimeout(timer);
  };
}
