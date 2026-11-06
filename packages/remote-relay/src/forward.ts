import type { Socket } from "node:net";
import type { ClientHttp2Stream } from "node:http2";
import { headers, paths } from "./protocol.js";
import type { Agent } from "./registration.js";
import type { TokenBucket } from "./bandwidth.js";
import type { Usage } from "./usage.js";
import { log } from "./log.js";

export function forward(
  socket: Socket,
  agent: Agent,
  id: string,
  usage: Usage,
  acme: boolean,
): void {
  const validation = usage.exceeded && acme;
  if (agent.phones.size >= 32 || (usage.exceeded && (!validation || usage.acmeRemaining === 0))) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true);
  const stream = agent.session.request({
    ":method": "POST",
    ":path": paths.tcp,
    [headers.clientAddress]: socket.remoteAddress,
    [headers.clientPort]: String(socket.remotePort),
  });
  agent.phones.add(socket);
  const abort = () => {
    socket.destroy();
    stream.destroy();
  };
  const deadline = validation ? setTimeout(abort, 10_000) : undefined;
  let bytes = 0;
  const account = (size: number) => {
    bytes += size;
    if (usage.add(size, validation)) {
      log("quota", id, socket.remoteAddress, usage.bytes);
      for (const phone of agent.phones) phone.destroy();
    }
    if (validation && (bytes >= 64 * 1024 || usage.acmeRemaining === 0)) abort();
  };
  socket.on("error", abort);
  stream.on("error", abort);
  stream.on("aborted", abort);
  stream.on("response", (response) => {
    if (response[":status"] !== 200) abort();
  });
  stream.once("close", () => {
    if (stream.rstCode !== 0) abort();
  });
  socket.once("close", () => {
    clearTimeout(deadline);
    agent.phones.delete(socket);
    if (!socket.readableEnded || !socket.writableFinished) stream.destroy();
  });

  function transfer(
    source: Socket | ClientHttp2Stream,
    target: Socket | ClientHttp2Stream,
    bucket: TokenBucket | undefined,
  ) {
    let timer: NodeJS.Timeout | undefined;
    let blocked = false;
    const pump = () => {
      if (timer || blocked || source.destroyed || target.destroyed) return;
      while (source.readableLength > 0) {
        const size = Math.min(
          source.readableLength,
          16 * 1024,
          bucket?.rate ?? Infinity,
          validation ? Math.min(64 * 1024 - bytes, usage.acmeRemaining) : Infinity,
        );
        if (size === 0) {
          abort();
          return;
        }
        const wait = bucket?.take(size) ?? 0;
        if (wait > 0) {
          timer = setTimeout(() => {
            timer = undefined;
            pump();
          }, wait);
          return;
        }
        const chunk = source.read(size) as Buffer;
        blocked = !target.write(chunk);
        account(chunk.length);
        if (blocked || source.destroyed || target.destroyed) return;
      }
      // Trigger end after the last buffered byte, without destroying either write side.
      source.read(0);
    };
    source.on("readable", pump);
    target.on("drain", () => {
      blocked = false;
      pump();
    });
    source.once("end", () => target.end());
    source.once("close", () => clearTimeout(timer));
    target.once("close", () => clearTimeout(timer));
    pump();
  }
  transfer(socket, stream, usage.upload);
  transfer(stream, socket, usage.download);
}
