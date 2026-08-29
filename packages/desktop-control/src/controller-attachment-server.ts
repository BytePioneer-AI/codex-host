import { createServer, type Server, type Socket } from "node:net";

const MAX_REQUEST_BYTES = 96;

export interface ControllerAttachmentServer {
  close(): Promise<void>;
}

export interface StartControllerAttachmentServerOptions {
  port: number;
  nonce: string;
  attach(): Promise<void>;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function validNonce(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function respond(socket: Socket, value: "ready" | "rejected" | "failed"): void {
  socket.end(`${value}\n`);
}

export async function startControllerAttachmentServer(
  options: StartControllerAttachmentServerOptions,
): Promise<ControllerAttachmentServer> {
  if (!validPort(options.port)) throw new Error("attachment port must be a valid TCP port");
  if (!validNonce(options.nonce)) {
    throw new Error("attachment nonce must be 32 lowercase hexadecimal characters");
  }

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    let request = "";
    let handled = false;
    socket.on("data", (chunk: string) => {
      if (handled) return;
      request += chunk;
      if (request.length > MAX_REQUEST_BYTES) {
        handled = true;
        respond(socket, "rejected");
        return;
      }
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = request.slice(0, newline).replace(/\r$/, "");
      if (line === `ATTACH ${options.nonce}`) {
        void options.attach().then(
          () => respond(socket, "ready"),
          () => respond(socket, "failed"),
        );
        return;
      }
      respond(socket, "rejected");
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}
