import { createConnection, type Socket } from "node:net";

export interface LocalPageHandle {
  show(): Promise<void>;
  close(): Promise<void>;
}

export function isLocalPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** The authenticated connection owns its page; disconnect always releases it. */
export async function serveLocalPage(
  socket: Socket,
  url: string,
  open: (url: string) => Promise<LocalPageHandle>,
): Promise<void> {
  let page: LocalPageHandle | undefined;
  let buffer = "";
  let operation = Promise.resolve();
  const disconnected = Promise.withResolvers<undefined>();
  socket.once("close", () => disconnected.resolve(undefined));
  socket.setTimeout(0);
  const receive = (chunk: string): void => {
    buffer += chunk;
    if (buffer.length > 64) {
      socket.destroy();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const command = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      operation = operation
        .then(async () => {
          if (socket.destroyed) return;
          if (command === "SHOW") {
            await page?.show();
            socket.write("ready\n");
          } else if (command === "CLOSE") {
            await page?.close();
            socket.end("closed\n");
          } else socket.destroy();
        })
        .catch(() => {
          socket.destroy();
        });
    }
  };
  try {
    page = await open(url);
    if (socket.destroyed) return;
    socket.on("data", receive);
    socket.write("ready\n");
    await disconnected.promise;
    await operation;
  } catch {
    if (!socket.destroyed) socket.end("failed\n");
  } finally {
    socket.off("data", receive);
    await page?.close();
  }
}

export function createLocalPageOpener(
  environment: NodeJS.ProcessEnv,
): ((url: string) => Promise<LocalPageHandle>) | undefined {
  const port = Number(environment.CODEXHOST_CONTROL_PORT);
  const nonce = environment.CODEXHOST_CONTROL_NONCE;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !nonce ||
    !/^[0-9a-f]{32}$/u.test(nonce)
  )
    return undefined;
  return async (url) => {
    if (!isLocalPageUrl(url) || Buffer.byteLength(url) > 2048)
      throw new Error("Local page requires a loopback root URL");
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setEncoding("utf8");
    let buffer = "";
    let pending: { resolve(): void; reject(error: Error): void } | undefined;
    let failure: Error | undefined;
    const fail = (): void => {
      failure ??= new Error("Codex local page connection closed");
      pending?.reject(failure);
      pending = undefined;
    };
    socket.on("error", fail);
    socket.on("close", fail);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const reply = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const request = pending;
      pending = undefined;
      if (reply === "ready" || reply === "closed") request?.resolve();
      else {
        request?.reject(new Error("Codex local page is unavailable"));
        socket.destroy();
      }
    });
    const request = async (command: string): Promise<void> => {
      if (failure) throw failure;
      if (pending) throw new Error("Local page operation already pending");
      const result = Promise.withResolvers<undefined>();
      pending = { resolve: () => result.resolve(undefined), reject: result.reject };
      const timeout = setTimeout(() => socket.destroy(), 10000);
      socket.write(command + "\n");
      try {
        await result.promise;
      } finally {
        clearTimeout(timeout);
      }
    };
    try {
      await request(`PAGE ${nonce} ${url}`);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    let operations = Promise.resolve();
    let closing: Promise<void> | undefined;
    return {
      show() {
        if (closing) return closing;
        operations = operations.then(() => request("SHOW"));
        return operations;
      },
      close() {
        closing ??= operations
          .catch(() => undefined)
          .then(async () => {
            if (!socket.destroyed && !failure) await request("CLOSE");
          })
          .catch(() => undefined)
          .finally(() => socket.destroy());
        return closing;
      },
    };
  };
}
