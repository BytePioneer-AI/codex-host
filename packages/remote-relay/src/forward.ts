import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { RelayOptions } from "./index.js";
import type { ClientHttp2Stream } from "node:http2";
import { headers, paths } from "./protocol.js";
import type { Agent } from "./registration.js";
import type { TokenBucket } from "./bandwidth.js";
import type { Usage } from "./usage.js";
import { log } from "./log.js";

export function forward(
  socket: Socket,
  agent: Agent,
  name: string,
  usage: Usage,
  acme: boolean,
  onUsage?: RelayOptions["onUsage"],
  onConnection?: RelayOptions["onConnection"],
): void {
  const validation = usage.exceeded && acme;
  if (agent.phones.size >= 32 || (usage.exceeded && (!validation || usage.acmeRemaining === 0))) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true);
  const id = randomUUID();
  const stream = agent.session.request({
    ":method": "POST",
    ":path": paths.tcp,
    [headers.clientAddress]: socket.remoteAddress,
    [headers.clientPort]: String(socket.remotePort),
    [headers.connectionId]: id,
  });
  agent.phones.add(socket);
  const connection = {
    type: "phone" as const,
    id,
    name,
    ip: socket.remoteAddress,
    startedAt: Date.now(),
    acme,
  };
  let authenticatedDay: string | undefined;
  if (!acme)
    agent.authentications.set(id, () => {
      const time = Date.now();
      const day = new Date(time).toISOString().slice(0, 10);
      if (socket.destroyed || authenticatedDay === day) return;
      authenticatedDay = day;
      onConnection?.({ ...connection, state: "authenticated", time });
    });
  const totals = { upload: 0, download: 0 };
  const abort = () => {
    socket.destroy();
    stream.destroy();
  };
  const deadline = validation ? setTimeout(abort, 10_000) : undefined;
  let bytes = 0;
  const account = (size: number, direction: "upload" | "download") => {
    bytes += size;
    totals[direction] += size;
    const quotaExceeded = usage.add(size, validation);
    onUsage?.(name, size, { direction, acme, quotaExceeded });
    if (quotaExceeded) {
      log("quota", name, socket.remoteAddress, usage.bytes);
      agent.notifyQuota();
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
    agent.authentications.delete(id);
    if (!socket.readableEnded || !socket.writableFinished) stream.destroy();
    onConnection?.({ ...connection, state: "close", endedAt: Date.now(), ...totals });
  });
  onConnection?.({ ...connection, state: "open" });

  function transfer(
    source: Socket | ClientHttp2Stream,
    target: Socket | ClientHttp2Stream,
    bucket: TokenBucket | undefined,
    direction: "upload" | "download",
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
        account(chunk.length, direction);
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
  transfer(socket, stream, usage.upload, "upload");
  transfer(stream, socket, usage.download, "download");
}
