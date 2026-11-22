import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readSync } from "node:fs";
import type { Socket } from "node:net";

export type ControllerLifecycle = (socket: Socket, line: string, trailing: string) => void;

/** The Launcher sends a fixed-size bootstrap over the Controller's private stdin pipe. */
export function readControllerLifecycle(
  nonce: string,
  stop: () => void,
): ControllerLifecycle | undefined {
  if (process.env.CODEXHOST_CONTROLLER_LIFECYCLE !== "1") return undefined;
  const bytes = Buffer.alloc(32);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(0, bytes, offset, bytes.length - offset, null);
    if (!count) throw new Error("Desktop Controller lifecycle bootstrap is incomplete");
    offset += count;
  }
  return controllerLifecycle(bytes, nonce, stop);
}

// Each connection gets its own server challenge. Neither a captured request nor a server
// proof can authorize shutdown, and this path never enters the Renderer operation queue.
export function controllerLifecycle(
  key: Buffer,
  context: string,
  stop: () => void,
): ControllerLifecycle {
  return (socket, line, trailing) => {
    const client = /^LIFECYCLE 1 ([0-9a-f]{32})$/u.exec(line)?.[1];
    if (!client || trailing) {
      socket.end("rejected\n");
      return;
    }
    const server = randomBytes(16).toString("hex");
    const transcript = `${context}:${process.pid}:${client}:${server}`;
    const proof = (role: string) =>
      createHmac("sha256", key).update(`${role}:${transcript}`).digest();
    socket.setTimeout(5_000);
    socket.write(`identity ${server} ${proof("identity").toString("hex")}\n`);
    let request = "";
    const receive = (chunk: string): void => {
      request += chunk;
      if (request.length <= 70 && !request.includes("\n")) return;
      socket.off("data", receive);
      const supplied = /^stop ([0-9a-f]{64})\n$/u.exec(request)?.[1];
      if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), proof("stop"))) {
        socket.end("rejected\n");
        return;
      }
      socket.end("stopping\n");
      stop();
    };
    socket.on("data", receive);
  };
}
