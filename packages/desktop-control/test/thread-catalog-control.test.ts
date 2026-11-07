import { createServer, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { requestDesktopThreadCatalogRefresh } from "../src/thread-catalog-control.js";

const nonce = "0123456789abcdef0123456789abcdef";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(reply: (socket: Socket) => void) {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const connected = vi.fn();
  const server = createServer((socket) => {
    connected();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (data: Buffer) => {
      received.push(data.toString("utf8"));
      reply(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(close);
  return {
    connected,
    received,
    close,
    environment: { CODEXHOST_CONTROL_PORT: String(address.port), CODEXHOST_CONTROL_NONCE: nonce },
  };
}

it("does no connection work when Desktop control configuration is absent or invalid", async () => {
  const f = await fixture((socket) => socket.end("ready\n"));
  for (const environment of [
    {},
    { CODEXHOST_CONTROL_PORT: f.environment.CODEXHOST_CONTROL_PORT },
    { ...f.environment, CODEXHOST_CONTROL_NONCE: "wrong" },
    { ...f.environment, CODEXHOST_CONTROL_PORT: "0" },
    { ...f.environment, CODEXHOST_CONTROL_PORT: "65536" },
  ])
    await expect(requestDesktopThreadCatalogRefresh(environment)).resolves.toBeUndefined();
  expect(f.connected).not.toHaveBeenCalled();
});

it.each(["ready", "failed", "rejected", "eof", "reset", "timeout"])(
  "settles a single catalog hint silently after %s without replaying it",
  async (mode) => {
    const f = await fixture((socket) => {
      if (mode === "timeout") return;
      if (mode === "reset") socket.resetAndDestroy();
      else socket.end(mode === "eof" ? "" : `${mode}\n`);
    });
    await expect(requestDesktopThreadCatalogRefresh(f.environment)).resolves.toBeUndefined();
    expect(f.connected).toHaveBeenCalledOnce();
    expect(f.received).toEqual([`CATALOG ${nonce}\n`]);
  },
);

it("ignores a stale Controller endpoint without starting or retrying Desktop", async () => {
  const f = await fixture((socket) => socket.end());
  await f.close();
  await expect(requestDesktopThreadCatalogRefresh(f.environment)).resolves.toBeUndefined();
  expect(f.connected).not.toHaveBeenCalled();
});
