import { createServer, type Server, type Socket } from "node:net";
import { isLocalPageUrl, serveLocalPage, type LocalPageHandle } from "./local-page-control.js";

const MAX_REQUEST_BYTES = 4096;

export interface ControllerAttachmentServer {
  close(): Promise<void>;
}

export interface StartControllerAttachmentServerOptions {
  port: number;
  nonce: string;
  attach(): Promise<void>;
  openLocalPage?(url: string): Promise<LocalPageHandle>;
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

function respond(socket: Socket, value: "ready" | "busy" | "rejected" | "failed"): void {
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
  const pages = new Set<Promise<void>>();
  let attachment: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    let request = "";
    let handled = false;
    const receive = (chunk: string): void => {
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
      const prefix = `PAGE ${options.nonce} `;
      if (options.openLocalPage && line.startsWith(prefix)) {
        const url = line.slice(prefix.length);
        if (!isLocalPageUrl(url) || request.slice(newline + 1) !== "") {
          respond(socket, "rejected");
          return;
        }
        socket.off("data", receive);
        const page = serveLocalPage(socket, url, options.openLocalPage).catch(() =>
          socket.destroy(),
        );
        const completion = page.then(() => undefined);
        pages.add(completion);
        void completion.finally(() => pages.delete(completion));
        return;
      }
      if (line === `ATTACH ${options.nonce}`) {
        if (attachment) {
          respond(socket, "busy");
          return;
        }
        // A Renderer recovery may legitimately outlive the request parsing deadline.
        // Keep exactly one recovery alive after its client disconnects, and reject
        // duplicate retries without appending more work to the Controller queue.
        socket.setTimeout(0);
        const current = Promise.resolve().then(() => options.attach());
        attachment = current;
        void current
          .then(
            () => respond(socket, "ready"),
            () => respond(socket, "failed"),
          )
          .finally(() => {
            if (attachment === current) attachment = undefined;
          });
        return;
      }
      respond(socket, "rejected");
    };
    socket.on("data", receive);
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
      await Promise.all(pages);
      await closeServer(server);
    },
  };
}
