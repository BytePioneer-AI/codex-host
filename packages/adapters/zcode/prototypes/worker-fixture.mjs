// Production codec helper serialized exactly as in DesktopClient, with an offline wire.
import { Worker } from "node:worker_threads";
import { desktopWorker } from "./adapter.mjs";

export async function workerChannel(createProtocol, openUpstream) {
  const worker = new Worker(`(${desktopWorker.toString()})().catch(()=>process.exit(1))`, {
    eval: true,
    stdin: true,
    stdout: true,
    stderr: true,
  });
  worker.stderr.resume();
  const ready = Promise.withResolvers(),
    pending = new Map(),
    events = new Map();
  let sequence = 0,
    buffer = "",
    gateway,
    upstream,
    closed = false;
  const write = (message) => {
    if (!closed) worker.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const fail = () => {
    const error = new Error("Offline codec helper failed");
    ready.reject(error);
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.stdin.on("error", () => {
    if (!closed) fail();
  });
  worker.on("exit", () => {
    if (!closed) fail();
  });
  worker.stdout.on("data", (data) => {
    if (closed) return;
    buffer += data.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.type === "ready") ready.resolve();
      else if (message.type === "frame") gateway.acceptPayload(message.payload);
      else if (message.type === "event") events.get(message.key)?.(message.value);
      else if (message.type === "result") {
        const value = pending.get(message.id);
        pending.delete(message.id);
        if (typeof message.error === "number")
          value?.reject(
            Object.assign(new Error("Native fixture request failed"), { code: message.error }),
          );
        else value?.resolve(message.result);
      } else fail();
    }
  });
  const request = (method, params, key) => {
    const id = ++sequence,
      result = Promise.withResolvers();
    pending.set(id, result);
    write({ type: "request", id, method, params, ...(key ? { key } : {}) });
    return result.promise;
  };
  const close = async () => {
    closed = true;
    gateway?.dispose();
    upstream?.disconnect();
    worker.stdin.end();
    await worker.terminate();
    events.clear();
    fail();
  };
  try {
    const identity = { bridgeSessionId: "offline-worker-bridge", bridgeGeneration: 1 };
    gateway = createProtocol({
      ...identity,
      sendFrame: (payload) => {
        write({ type: "frame", payload });
        return true;
      },
    });
    write({
      type: "init",
      archive: "/Applications/ZCode.app/Contents/Resources/app.asar",
      identity,
    });
    await ready.promise;
    upstream = openUpstream();
    gateway.protocol.onMessage((message) => upstream.send(message));
    upstream.onMessage((message) => gateway.protocol.send(message));
    return {
      channel: {
        call: (method, [params]) => request(method, params),
        listen:
          (method, [params]) =>
          (listener) => {
            const key = `event-${++sequence}`;
            events.set(key, listener);
            void request(method, params, key).catch(fail);
            return {
              dispose: () => {
                events.delete(key);
                if (!closed) void request("unsubscribe", {}, key).catch(fail);
              },
            };
          },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
